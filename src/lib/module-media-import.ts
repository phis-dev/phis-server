import "server-only";

import { createHash } from "node:crypto";

import { hasLockedMediaFolder, normalizeFolderPathSegment } from "@/db/media";
import {
  ensureSiteMediaConfig,
  ensureSiteMediaSpace,
  getMediaStorageProfile,
  isPhiMediaObjectSizeAllowed,
} from "@/db/media-spaces";
import {
  deleteSiteModuleMediaFile,
  deleteSiteModuleMediaFolder,
  findMediaFolderByName,
  getSiteModuleMediaFile,
  getSiteModuleMediaFolder,
  insertMediaFolder,
  isSiteModuleMediaBound,
  siteSpaceHoldsAsset,
  siteSpaceHoldsFolder,
  withSiteModuleMediaLock,
  writeSiteModuleMediaFile,
  writeSiteModuleMediaFolder,
} from "@/db/site-module-media";
import { PhisSiteModuleMediaFlag } from "@/lib/constants/media";
import { inspectPhiMediaObject } from "@/lib/media-content-check";
import { openSiteMediaWriteStorage, writeSiteMediaAsset } from "@/lib/site-media-write";
import {
  PHIS_MODULE_MEDIA_FOLDER_NAME_MAX_LENGTH,
  PHIS_MODULE_MEDIA_TEXT_MAX_LENGTH,
  type PhisModuleMediaOutcome,
} from "@/lib/module-media";

/**
 * The import of a Module package's media into a Site's library (design/MODULE_MEDIA.md, section 5).
 *
 * One item per call, under the Site's lock, and every call answers what it did: the CLI decides what to
 * send, Core decides what happens. The rules, in the order they are applied:
 *
 * - a row with `Bound` is left alone, whatever it points at;
 * - a row whose target is there stands. For a file the received bytes are compared with the digest the
 *   row recorded; a changed file follows the package only while the Asset still carries that digest, that
 *   is while nobody changed it;
 * - a row that is absent, or whose target is gone, is made again: the Folder by name under its declared
 *   parent in the Site Space (an existing Folder of that name is bound, not duplicated), the file written
 *   through the Storage Service into the Storage Profile the Site Space writes new uploads to, checked
 *   like an upload, booked against the Space's quota in the same transaction as the Asset and the row.
 *
 * Core has no way to replace the content of an Asset under its id: `media_assets` has no write that moves
 * `storage_key` or the digest, and delivery revisions rotate only on metadata. A changed file is therefore
 * a new Asset, the row moved to it, and the old Asset left in the library; the answer says so.
 */

type Site = { id: number; key: string };

export type PhisModuleMediaFileInput = {
  packageName: string;
  key: string;
  /** The key of the declared folder the file belongs in, or null for the Space's root. */
  folderKey: string | null;
  alt: string;
  title: string | null;
  originalName: string;
  body: Buffer;
};

export type PhisModuleMediaFolderInput = {
  packageName: string;
  key: string;
  name: string;
  parentKey: string | null;
};

const refused = (
  kind: "folder" | "file",
  packageName: string,
  key: string,
  reason: string,
  detail: string,
): PhisModuleMediaOutcome => ({ kind, packageName, key, status: "refused", reason, detail });

export async function importModuleMediaFolder(site: Site, input: PhisModuleMediaFolderInput): Promise<PhisModuleMediaOutcome> {
  const { packageName, key } = input;
  const name = normalizeFolderPathSegment(input.name);
  if (!name || name.length > PHIS_MODULE_MEDIA_FOLDER_NAME_MAX_LENGTH) {
    return refused("folder", packageName, key, "invalid_name", `A folder name is 1 to ${PHIS_MODULE_MEDIA_FOLDER_NAME_MAX_LENGTH} characters.`);
  }
  const { space } = await ensureSiteMediaSpace(site.id);

  return withSiteModuleMediaLock(site.id, async (db) => {
    const row = await getSiteModuleMediaFolder(db, site.id, packageName, key);
    if (row && isSiteModuleMediaBound(row)) {
      return { kind: "folder", packageName, key, status: "bound-left", ...(row.folderId !== null ? { folderId: row.folderId } : {}) };
    }
    if (row?.folderId != null) {
      return { kind: "folder", packageName, key, status: "unchanged", folderId: row.folderId };
    }

    let parentId: number | null = null;
    if (input.parentKey !== null) {
      const parent = await getSiteModuleMediaFolder(db, site.id, packageName, input.parentKey);
      if (!parent || parent.folderId === null) {
        return refused("folder", packageName, key, "parent_missing", `The parent folder "${input.parentKey}" has no Folder on this Site; it is imported first.`);
      }
      parentId = parent.folderId;
      // As an upload and a hand-made sub-folder: nothing is created in a locked Folder.
      if (await hasLockedMediaFolder(site.id, space.id, [parentId])) {
        return refused("folder", packageName, key, "media_folder_locked", "The Media Folder is locked.");
      }
    }

    const existing = await findMediaFolderByName(db, { siteId: site.id, spaceId: space.id, parentId, name });
    const folderId = existing ?? await insertMediaFolder(db, { siteId: site.id, spaceId: space.id, parentId, name });
    await writeSiteModuleMediaFolder(db, { siteId: site.id, packageName, key, folderId, flags: 0 });
    return {
      kind: "folder",
      packageName,
      key,
      status: row ? "repaired" : "created",
      folderId,
      ...(existing !== null ? { detail: `A folder of that name was already there; the name is bound to it.` } : {}),
    };
  });
}

export async function importModuleMediaFile(site: Site, input: PhisModuleMediaFileInput): Promise<PhisModuleMediaOutcome> {
  const { packageName, key } = input;
  const fail = (reason: string, detail: string) => refused("file", packageName, key, reason, detail);

  if (input.body.byteLength === 0) return fail("empty_file", "The file is empty.");
  if (input.alt.length > PHIS_MODULE_MEDIA_TEXT_MAX_LENGTH || (input.title?.length ?? 0) > PHIS_MODULE_MEDIA_TEXT_MAX_LENGTH) {
    return fail("invalid_text", `alt and title are at most ${PHIS_MODULE_MEDIA_TEXT_MAX_LENGTH} characters.`);
  }
  const mediaConfig = await ensureSiteMediaConfig(site.id);
  if (!isPhiMediaObjectSizeAllowed(input.body.byteLength, mediaConfig)) {
    return fail("media_asset_too_large", `The file is larger than the ${mediaConfig.maxObjectBytes} byte limit of this Site.`);
  }
  const sha256 = createHash("sha256").update(input.body).digest("hex");
  const { space } = await ensureSiteMediaSpace(site.id);
  // The Profile the Space writes new uploads to, read as `uploads/init` reads it.
  const profile = await getMediaStorageProfile(site.id, space.defaultStorageProfileId);
  if (!profile) return fail("storage_profile_unavailable", "The Site Space's Storage Profile is unavailable.");

  /*
   * The object is written inside the transaction but outlives a failure of it: whatever rejects after
   * `putObject` succeeded -- the callback or the COMMIT -- leaves an object no Asset points at, so the
   * cleanup covers the whole transaction.
   */
  const written: { discard?: () => Promise<void> } = {};
  try {
  return await withSiteModuleMediaLock(site.id, async (db): Promise<PhisModuleMediaOutcome> => {
    const row = await getSiteModuleMediaFile(db, site.id, packageName, key);
    if (row && isSiteModuleMediaBound(row)) {
      return { kind: "file", packageName, key, status: "bound-left", ...(row.assetId !== null ? { assetId: row.assetId } : {}) };
    }

    let replacing: number | null = null;
    if (row?.assetId != null) {
      if (row.sourceChecksum === sha256) {
        return { kind: "file", packageName, key, status: "unchanged", assetId: row.assetId };
      }
      if (row.sourceChecksum === null || row.assetChecksum !== row.sourceChecksum) {
        return {
          kind: "file", packageName, key, status: "unchanged", assetId: row.assetId,
          detail: "The package file changed, but the Asset is no longer what the import wrote; it is left.",
        };
      }
      replacing = row.assetId;
    }

    let folderId: number | null = null;
    if (input.folderKey !== null) {
      const folder = await getSiteModuleMediaFolder(db, site.id, packageName, input.folderKey);
      if (!folder || folder.folderId === null) {
        return fail("folder_missing", `The folder "${input.folderKey}" has no Folder on this Site; folders are imported first.`);
      }
      folderId = folder.folderId;
      // The same check `uploads/init` makes on the target Folder, hand-bound ones included.
      if (await hasLockedMediaFolder(site.id, space.id, [folderId])) {
        return fail("media_folder_locked", "The Media Folder is locked.");
      }
    }

    const opened = await openSiteMediaWriteStorage(site, profile);
    if ("reason" in opened) return fail(opened.reason, opened.detail);
    const inspection = await inspectPhiMediaObject({
      body: input.body,
      declaredContentType: "application/octet-stream",
      space,
      mediaConfig,
    });
    if (!inspection.ok) return fail(inspection.code, inspection.message);

    const originalName = input.originalName.slice(0, PHIS_MODULE_MEDIA_TEXT_MAX_LENGTH);
    const asset = await writeSiteMediaAsset(db, {
      site, space, profile, inspection, folderId, originalName, storage: opened.storage, body: input.body, written,
      title: input.title, altText: input.alt, meta: { source: "module", package: packageName, key },
    });
    if (!asset) return fail("media_quota_exceeded", "The Site Space's quota is used up.");
    await writeSiteModuleMediaFile(db, { siteId: site.id, packageName, key, assetId: asset.id, sourceChecksum: sha256, flags: 0 });
    return replacing !== null
      ? {
        kind: "file", packageName, key, status: "replaced", assetId: asset.id, previousAssetId: replacing,
        detail: `Core cannot replace an Asset's content under its id: Asset ${asset.id} was created, the name moved to it, and Asset ${replacing} is left in the library; a stored Page keeps the old picture.`,
      }
      : { kind: "file", packageName, key, status: row ? "repaired" : "created", assetId: asset.id };
  });
  } catch (error) {
    await written.discard?.();
    throw error;
  }
}

export type PhisModuleMediaBindInput = {
  packageName: string;
  key: string;
} & ({ asset: number } | { folder: number } | { reset: true });

export type PhisModuleMediaBindResult =
  | { ok: true; action: "bound" | "reset"; kind: "file" | "folder" }
  | { ok: false; reason: "target_not_in_site_space" | "key_is_other_kind" | "not_bound"; detail: string };

/**
 * A hand binding, or the end of one.
 *
 * The target has to be an Asset or Folder of the Site Space of this Site, the one library a Module's
 * names live in; a User's or a Group's Space is not the Site's content. Setting `Bound` also drops the
 * digest the row held, which described a package file this name no longer follows. A reset removes the
 * row, so the next `sync` makes the name from the package again; it applies only to a bound row, because
 * resetting a package's own row would write its file a second time.
 */
export async function bindModuleMedia(site: Site, input: PhisModuleMediaBindInput): Promise<PhisModuleMediaBindResult> {
  const { space } = await ensureSiteMediaSpace(site.id);
  const { packageName, key } = input;

  return withSiteModuleMediaLock(site.id, async (db): Promise<PhisModuleMediaBindResult> => {
    if ("reset" in input) {
      const [file, folder] = await Promise.all([
        getSiteModuleMediaFile(db, site.id, packageName, key),
        getSiteModuleMediaFolder(db, site.id, packageName, key),
      ]);
      if (file && isSiteModuleMediaBound(file)) {
        await deleteSiteModuleMediaFile(db, site.id, packageName, key);
        return { ok: true, action: "reset", kind: "file" };
      }
      if (folder && isSiteModuleMediaBound(folder)) {
        await deleteSiteModuleMediaFolder(db, site.id, packageName, key);
        return { ok: true, action: "reset", kind: "folder" };
      }
      return { ok: false, reason: "not_bound", detail: `"${key}" of ${packageName} is not bound by hand; there is nothing to reset.` };
    }

    if ("asset" in input) {
      if (await getSiteModuleMediaFolder(db, site.id, packageName, key)) {
        return { ok: false, reason: "key_is_other_kind", detail: `"${key}" of ${packageName} is a folder; bind it with --folder.` };
      }
      if (!await siteSpaceHoldsAsset(db, site.id, space.id, input.asset)) {
        return { ok: false, reason: "target_not_in_site_space", detail: `Asset ${input.asset} is not in the Site Space of ${site.key}.` };
      }
      await writeSiteModuleMediaFile(db, {
        siteId: site.id, packageName, key, assetId: input.asset, sourceChecksum: null, flags: PhisSiteModuleMediaFlag.Bound,
      });
      return { ok: true, action: "bound", kind: "file" };
    }

    if (await getSiteModuleMediaFile(db, site.id, packageName, key)) {
      return { ok: false, reason: "key_is_other_kind", detail: `"${key}" of ${packageName} is a file; bind it with --asset.` };
    }
    if (!await siteSpaceHoldsFolder(db, site.id, space.id, input.folder)) {
      return { ok: false, reason: "target_not_in_site_space", detail: `Folder ${input.folder} is not in the Site Space of ${site.key}.` };
    }
    await writeSiteModuleMediaFolder(db, {
      siteId: site.id, packageName, key, folderId: input.folder, flags: PhisSiteModuleMediaFlag.Bound,
    });
    return { ok: true, action: "bound", kind: "folder" };
  });
}
