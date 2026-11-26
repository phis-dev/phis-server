import "server-only";

import { createHash } from "node:crypto";

import {
  getMediaAssetBySiteAndChecksum,
  hasLockedMediaFolder,
  listMediaFolders,
  normalizeFolderPathSegment,
  withMediaSourceImportLock,
} from "@/db/media";
import {
  ensureSiteMediaConfig,
  ensureSiteMediaSpace,
  getMediaStorageProfile,
  isPhiMediaObjectSizeAllowed,
  PhiMediaLifecycleStatus,
} from "@/db/media-spaces";
import {
  findMediaFolderByName,
  insertMediaFolder,
  siteSpaceHoldsFolder,
  withSiteModuleMediaLock,
} from "@/db/site-module-media";
import { getPool } from "@/lib/db";
import { inspectPhiMediaObject, PHI_IMAGE_DECODE_LIMIT_BYTES } from "@/lib/media-content-check";
import {
  PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH,
  type PhisMediaImportFileOutcome,
  type PhisMediaImportFolderOutcome,
  type PhisMediaImportFolderRequest,
} from "@/lib/media-import";
import {
  openSiteMediaWriteStorage,
  putSiteMediaObject,
  recordSiteMediaAsset,
  SiteMediaBodyLengthError,
} from "@/lib/site-media-write";

/**
 * `phis media import`: local files into a Site's Media library, without a package and without a name
 * mapping (docs/CLI.md, "Media import").
 *
 * The same writer as a Module's media and a media source's item (`site-media-write.ts`): the Site Space,
 * the Profile it writes new files to, the content checks of an upload, the Site's object limit, its quota,
 * a `Ready` Asset delivered as the Site Space delivers -- publicly. What differs is only what a file
 * arrives as: a stream with its length stated, which is held in memory up to the image decode limit and
 * streamed to the Provider past it, so no request holds a file of the Site's object limit.
 *
 * Every file is its own import, answered on its own. No transaction is held while a body arrives: the
 * object is written first, then booked under the lock that serialises imports of the same bytes into one
 * Space, where the quota is reserved and committed with the Asset. Bytes already in the Site Space are
 * answered as the Asset they are, as a media source's item is, and not written a second time.
 */

type Site = { id: number; key: string };

const refuse = (reason: string, detail: string) => ({ status: "refused" as const, reason, detail });

/** The Folder an import goes into: made by name along its path where absent, or named by id. */
export async function ensureSiteMediaImportFolder(
  site: Site,
  request: PhisMediaImportFolderRequest,
): Promise<PhisMediaImportFolderOutcome> {
  const { space } = await ensureSiteMediaSpace(site.id);

  if ("id" in request) {
    if (!await siteSpaceHoldsFolder(getPool(), site.id, space.id, request.id)) {
      return refuse("folder_not_found", `Folder ${request.id} is not in the Site Space of ${site.key}.`);
    }
    if (await hasLockedMediaFolder(site.id, space.id, [request.id])) {
      return refuse("media_folder_locked", "The Media Folder is locked.");
    }
    const folders = new Map((await listMediaFolders(site.id, space.id)).map((folder) => [folder.id, folder]));
    const path: string[] = [];
    for (let current = folders.get(request.id); current; current = current.parentId !== null ? folders.get(current.parentId) : undefined) {
      path.unshift(current.name);
      if (path.length > folders.size) break;
    }
    return { status: "ready", folderId: request.id, path, created: [] };
  }

  const names = request.path.map(normalizeFolderPathSegment);
  // Under the lock the Module media import makes its Folders under, so the two never make one name twice.
  return withSiteModuleMediaLock(site.id, async (db): Promise<PhisMediaImportFolderOutcome> => {
    let parentId: number | null = null;
    const path: string[] = [];
    const created: string[] = [];
    for (const name of names) {
      const existing: number | null = await findMediaFolderByName(db, { siteId: site.id, spaceId: space.id, parentId, name });
      if (existing !== null) {
        parentId = existing;
      } else {
        // As an upload and a hand-made sub-folder: nothing is created in a locked Folder.
        if (parentId !== null && await hasLockedMediaFolder(site.id, space.id, [parentId])) {
          return refuse("media_folder_locked", `The Media Folder "${path.join("/")}" is locked; "${name}" cannot be made in it.`);
        }
        parentId = await insertMediaFolder(db, { siteId: site.id, spaceId: space.id, parentId, name });
        created.push(name);
      }
      path.push(name);
    }
    if (created.length === 0 && await hasLockedMediaFolder(site.id, space.id, [parentId])) {
      return refuse("media_folder_locked", "The Media Folder is locked.");
    }
    return { status: "ready", folderId: parentId!, path, created };
  });
}

/**
 * A stated-length stream read far enough to be checked: whole when it ends within `limit` (the image
 * decode limit, so every check `inspectPhiMediaObject` makes on a whole object is made), otherwise the
 * bytes read so far and the whole stream again, those bytes first, to be put as one.
 */
export async function holdSiteMediaImportBody(
  stream: ReadableStream<Uint8Array>,
  byteLength: number,
  limit: number = PHI_IMAGE_DECODE_LIMIT_BYTES,
): Promise<{ whole: Buffer } | { head: Buffer; stream: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let held = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      const whole = Buffer.concat(chunks);
      if (whole.byteLength !== byteLength) throw new SiteMediaBodyLengthError(byteLength, whole.byteLength);
      return { whole };
    }
    chunks.push(value);
    held += value.byteLength;
    if (held > byteLength) throw new SiteMediaBodyLengthError(byteLength, held);
    if (held > limit) break;
  }
  const head = Buffer.concat(chunks);
  let headSent = false;
  const again = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headSent) {
        headSent = true;
        controller.enqueue(head);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return { head, stream: again };
}

export type SiteMediaImportFileInput = {
  body: ReadableStream<Uint8Array>;
  byteLength: number;
  /** Ends the write when the body stops arriving (`watchPhiMediaUploadBody`). */
  signal?: AbortSignal;
  folderId: number | null;
  originalName: string;
  alt: string | null;
  title: string | null;
};

/** One file into the Site Space, answered as what it became or why not; a refusal books and keeps nothing. */
export async function importSiteMediaFile(site: Site, input: SiteMediaImportFileInput): Promise<PhisMediaImportFileOutcome> {
  const { byteLength } = input;
  const originalName = input.originalName.replace(/^.*[\\/]/u, "").trim();
  if (!originalName || originalName.length > PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH) {
    return refuse("invalid_name", `A file name is 1 to ${PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH} characters.`);
  }
  if ((input.alt?.length ?? 0) > PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH || (input.title?.length ?? 0) > PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH) {
    return refuse("invalid_text", `alt and title are at most ${PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH} characters.`);
  }
  if (byteLength === 0) return refuse("empty_file", "The file is empty.");

  // What can be refused before a byte is read, is.
  const mediaConfig = await ensureSiteMediaConfig(site.id);
  if (!isPhiMediaObjectSizeAllowed(byteLength, mediaConfig)) {
    return refuse("media_asset_too_large", `The file is larger than the ${mediaConfig.maxObjectBytes} byte limit of this Site.`);
  }
  const { space } = await ensureSiteMediaSpace(site.id);
  const profile = await getMediaStorageProfile(site.id, space.defaultStorageProfileId);
  if (!profile) return refuse("storage_profile_unavailable", "The Site Space's Storage Profile is unavailable.");
  if (input.folderId !== null) {
    if (!await siteSpaceHoldsFolder(getPool(), site.id, space.id, input.folderId)) {
      return refuse("folder_not_found", `Folder ${input.folderId} is not in the Site Space of ${site.key}.`);
    }
    if (await hasLockedMediaFolder(site.id, space.id, [input.folderId])) {
      return refuse("media_folder_locked", "The Media Folder is locked.");
    }
  }
  const opened = await openSiteMediaWriteStorage(site, profile);
  if ("reason" in opened) return refuse(opened.reason, opened.detail);
  // An early answer for a Space that is plainly full; the reservation below is what decides.
  if (space.quotaBytes !== null && space.usedBytes + space.reservedBytes + byteLength > space.quotaBytes) {
    return refuse("media_quota_exceeded", "The Site Space's quota is used up.");
  }

  let held;
  try {
    held = await holdSiteMediaImportBody(input.body, byteLength);
  } catch (error) {
    if (error instanceof SiteMediaBodyLengthError) return refuse("body_length_mismatch", error.message);
    throw error;
  }
  const inspection = await inspectPhiMediaObject({
    body: "whole" in held ? held.whole : held.head,
    byteLength,
    declaredContentType: "application/octet-stream",
    space,
    mediaConfig,
  });
  if (!inspection.ok) return refuse(inspection.code, inspection.message);

  const existingAnswer = (asset: NonNullable<Awaited<ReturnType<typeof getMediaAssetBySiteAndChecksum>>>): PhisMediaImportFileOutcome => ({
    status: "existing",
    assetId: asset.id,
    name: asset.originalName,
    contentType: asset.contentType,
    bytes: asset.bytes ?? byteLength,
    folderId: asset.folderId,
    detail: `These bytes are already Asset ${asset.id} of the Site Space; nothing was written, and its folder and texts are left as they are.`,
  });
  // Bytes in hand are looked up before they are written; a stream's digest is known only once it is.
  if ("whole" in held) {
    const sha256 = createHash("sha256").update(held.whole).digest("hex");
    const existing = await getMediaAssetBySiteAndChecksum(site.id, space.id, { algorithm: "sha256", value: sha256 });
    if (existing && existing.lifecycleStatus === PhiMediaLifecycleStatus.Ready) return existingAnswer(existing);
  }

  const written: { discard?: () => Promise<void> } = {};
  try {
    const object = await putSiteMediaObject({
      site,
      storage: opened.storage,
      source: "whole" in held
        ? { body: held.whole }
        : { stream: held.stream, byteLength, ...(input.signal ? { signal: input.signal } : {}) },
      contentType: inspection.contentType,
      originalName,
      written,
    });
    const outcome = await withMediaSourceImportLock({ spaceId: space.id, checksum: object.sha256 }, async (db): Promise<PhisMediaImportFileOutcome> => {
      const existing = await getMediaAssetBySiteAndChecksum(site.id, space.id, { algorithm: "sha256", value: object.sha256 });
      if (existing && existing.lifecycleStatus === PhiMediaLifecycleStatus.Ready) return existingAnswer(existing);
      // The Folder may have gone or been locked while the body arrived.
      if (input.folderId !== null) {
        if (!await siteSpaceHoldsFolder(db, site.id, space.id, input.folderId)) {
          return refuse("folder_not_found", `Folder ${input.folderId} is not in the Site Space of ${site.key}.`);
        }
        if (await hasLockedMediaFolder(site.id, space.id, [input.folderId])) {
          return refuse("media_folder_locked", "The Media Folder is locked.");
        }
      }
      const asset = await recordSiteMediaAsset(db, {
        site, space, profile, object, inspection, folderId: input.folderId, originalName,
        title: input.title, altText: input.alt, meta: { source: "cli" },
      });
      if (!asset) return refuse("media_quota_exceeded", "The Site Space's quota is used up.");
      return {
        status: "created",
        assetId: asset.id,
        name: asset.originalName,
        contentType: asset.contentType,
        bytes: asset.bytes ?? object.byteSize,
        folderId: asset.folderId,
      };
    });
    if (outcome.status !== "created") await written.discard?.();
    return outcome;
  } catch (error) {
    await written.discard?.();
    if (error instanceof SiteMediaBodyLengthError) return refuse("body_length_mismatch", error.message);
    throw error;
  }
}
