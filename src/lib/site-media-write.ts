import "server-only";

import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { createMediaAsset, type MediaAssetRecord } from "@/db/media";
import {
  isMediaStorageProfileWritable,
  PhiMediaLifecycleStatus,
  reserveMediaSpaceQuota,
  type MediaSpaceRecord,
  type MediaStorageProfileRecord,
} from "@/db/media-spaces";
import { commitMediaSpaceBytes } from "@/db/site-module-media";
import { PhiServiceProviderUnavailableError } from "@/lib/addons/services";
import type { PhiMediaObjectInspection } from "@/lib/media-content-check";
import { createPhisMediaStorageServiceForProfile, type PhisMediaStorageService } from "@/lib/media-storage";

/**
 * Writing one object into a Site's Media library on the server's own behalf, as an ordinary Asset.
 *
 * Three writers do this without an upload session: a Module package's media (`module-media-import.ts`), an
 * item of a media source (`media-sources.ts`) and `phis media import` (`site-media-import.ts`). Each decides
 * on its own what it writes and under which lock; what writing is, is here, once:
 *
 * - the Storage Service of the Profile the Space writes new files to, refused while the Profile is disabled
 *   or its Provider cannot be opened on this Instance;
 * - the object put through it, from bytes in hand or streamed, its SHA-256 taken from what was written;
 * - the Asset row and the quota booked in the caller's transaction: reserved and committed together, so a
 *   refusal or a rollback books nothing. Bytes in hand are reserved before they are written
 *   (`writeSiteMediaAsset`); a stream is written first and booked after (`recordSiteMediaAsset`), because
 *   no transaction is held open while a body arrives.
 *
 * The object is written before the row and outlives a failure of the transaction, so the caller keeps the
 * `discard` of what was written and calls it on every path that does not end in a committed Asset.
 */

type Site = { id: number; key: string };

export type SiteMediaWriteRefusal = { reason: string; detail: string };

/** The Storage Service the Site Space writes new files to, or why there is none. */
export async function openSiteMediaWriteStorage(
  site: Site,
  profile: MediaStorageProfileRecord,
): Promise<{ storage: PhisMediaStorageService } | SiteMediaWriteRefusal> {
  if (!isMediaStorageProfileWritable(profile)) {
    return { reason: "storage_profile_disabled", detail: "The Site Space's Storage Profile is disabled; it takes no new files." };
  }
  try {
    return { storage: await createPhisMediaStorageServiceForProfile(profile, site.key) };
  } catch (error) {
    if (error instanceof PhiServiceProviderUnavailableError) {
      return {
        reason: "storage_provider_unavailable",
        detail: `The Storage Provider ${profile.providerId} cannot be opened on this Instance: ${error.reason}.`,
      };
    }
    throw error;
  }
}

export class SiteMediaBodyLengthError extends Error {
  constructor(expected: number, received: number) {
    super(`The body carried ${received} byte(s) where ${expected} were stated.`);
    this.name = "SiteMediaBodyLengthError";
  }
}

/** Bytes in hand, or a stream whose length was stated before it began. */
export type SiteMediaWriteBody =
  | { body: Buffer }
  | { stream: ReadableStream<Uint8Array>; byteLength: number; signal?: AbortSignal };

export type SiteMediaStoredObject = {
  storageKey: string;
  byteSize: number;
  sha256: string;
};

/**
 * Puts the object under a fresh key and answers what was written.
 *
 * A stream is counted and hashed on its way to the Provider and fails as `SiteMediaBodyLengthError` the
 * moment it carries more than it stated, or at its end when it carried less, so a torn object is never
 * answered as written. `written.discard` is set before the first byte goes out, whatever happens next.
 */
export async function putSiteMediaObject(input: {
  site: Site;
  storage: PhisMediaStorageService;
  source: SiteMediaWriteBody;
  contentType: string;
  originalName: string;
  written: { discard?: () => Promise<void> };
}): Promise<SiteMediaStoredObject> {
  const { site, storage, source } = input;
  const storageKey = storage.createStorageKey({ siteKey: site.key });
  input.written.discard = async () => { await storage.deleteObject(storageKey).catch(() => {}); };
  const metadata = { siteKey: site.key, filename: input.originalName };

  if ("body" in source) {
    const stored = await storage.putObject({ storageKey, body: source.body, contentType: input.contentType, metadata });
    return { storageKey: stored.storageKey, byteSize: stored.byteSize, sha256: createHash("sha256").update(source.body).digest("hex") };
  }

  const hash = createHash("sha256");
  let received = 0;
  const counted = source.stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > source.byteLength) {
        controller.error(new SiteMediaBodyLengthError(source.byteLength, received));
        return;
      }
      hash.update(chunk);
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (received !== source.byteLength) controller.error(new SiteMediaBodyLengthError(source.byteLength, received));
    },
  }));
  const stored = await storage.putObjectStream({
    storageKey,
    body: counted,
    contentType: input.contentType,
    metadata,
    ...(source.signal ? { signal: source.signal } : {}),
  });
  if (received !== source.byteLength || stored.byteSize !== source.byteLength) {
    throw new SiteMediaBodyLengthError(source.byteLength, stored.byteSize);
  }
  return { storageKey: stored.storageKey, byteSize: stored.byteSize, sha256: hash.digest("hex") };
}

export type SiteMediaAssetFields = {
  site: Site;
  space: Pick<MediaSpaceRecord, "id" | "kind">;
  profile: Pick<MediaStorageProfileRecord, "id">;
  inspection: Extract<PhiMediaObjectInspection, { ok: true }>;
  folderId: number | null;
  originalName: string;
  title: string | null;
  altText: string | null;
  meta: Record<string, unknown>;
  actorUserId?: number | null;
};

/**
 * Bytes in hand into the Site's library, in `db`'s transaction: the quota reserved first, so a Space with no
 * room is refused before anything is written, then the object, then the Asset with the bytes committed.
 * Null where the quota has no room; nothing is written or booked then.
 */
export async function writeSiteMediaAsset(db: PoolClient, input: SiteMediaAssetFields & {
  storage: PhisMediaStorageService;
  body: Buffer;
  written: { discard?: () => Promise<void> };
}): Promise<MediaAssetRecord | null> {
  if (!await reserveMediaSpaceQuota({ spaceId: input.space.id, bytes: input.body.byteLength }, db)) return null;
  const object = await putSiteMediaObject({
    site: input.site,
    storage: input.storage,
    source: { body: input.body },
    contentType: input.inspection.contentType,
    originalName: input.originalName,
    written: input.written,
  });
  return insertSiteMediaAsset(db, input, object);
}

/**
 * The Asset for an object already written -- streamed outside any transaction, as `phis media import` does
 * -- with its bytes reserved and committed in `db`'s. Null where the quota has no room: nothing is booked
 * then, and the caller discards the object.
 */
export async function recordSiteMediaAsset(db: PoolClient, input: SiteMediaAssetFields & {
  object: SiteMediaStoredObject;
}): Promise<MediaAssetRecord | null> {
  if (!await reserveMediaSpaceQuota({ spaceId: input.space.id, bytes: input.object.byteSize }, db)) return null;
  return insertSiteMediaAsset(db, input, input.object);
}

/**
 * The row and the commit of the reserved bytes. The Asset is `Ready`, and its delivery the Space's default
 * -- public for the Site Space -- exactly as a finished upload's.
 */
async function insertSiteMediaAsset(db: PoolClient, input: SiteMediaAssetFields, object: SiteMediaStoredObject) {
  const { site, space, inspection } = input;
  const asset = await createMediaAsset({
    siteId: site.id,
    spaceId: space.id,
    spaceKind: space.kind,
    folderId: input.folderId,
    createdByUserId: input.actorUserId ?? null,
    updatedByUserId: input.actorUserId ?? null,
    storageProfileId: input.profile.id,
    storageKey: object.storageKey,
    originalName: input.originalName,
    contentType: inspection.contentType,
    bytes: object.byteSize,
    checksumAlgorithm: "sha256",
    checksumValue: object.sha256,
    width: inspection.width,
    height: inspection.height,
    blurDataUrl: inspection.blurDataUrl,
    meta: input.meta,
    title: input.title,
    altText: input.altText,
    lifecycleStatus: PhiMediaLifecycleStatus.Ready,
  }, db);
  if (!asset) throw new Error("Failed to persist media asset.");
  await commitMediaSpaceBytes(db, { spaceId: space.id, bytes: object.byteSize });
  return asset;
}
