import "server-only";

import type { MediaAssetRecord } from "@/db/media";
import {
  discardPhiMediaAssets,
  forgetPhiDiscardedMediaObjects,
  readPhiDiscardedMediaObjects,
  type PhiDiscardedMediaObject,
} from "@/db/media-discard";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { getPool } from "@/lib/db";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";

/**
 * How many older notes a caller clears while it is at the store anyway.
 *
 * Small on purpose. Every deletion pays for a few, so the debt drains at the rate things are deleted
 * and no scheduled pass is needed for the ordinary case -- and because the list is read by an index
 * rather than searched for, the cost is the same whether it holds nothing or a thousand.
 */
const PHI_MEDIA_DISCARD_DRAIN_LIMIT = 10;

/**
 * Removes objects the database has already given up on, and clears the notes for the ones that went.
 *
 * A note is kept only where the store actually refused. An object the store no longer has is the state
 * being asked for, so a delete that reports "there was nothing" is a success -- keeping the note for it
 * would mean retrying it forever.
 */
export async function drainPhiDiscardedMediaObjects(input: {
  siteId: number;
  siteKey?: string | null;
  objects?: readonly PhiDiscardedMediaObject[];
  /** Whether to pick up older notes as well. Off where the caller only wants its own removed. */
  includePending?: boolean;
}) {
  const pending = input.includePending === false
    ? []
    : await readPhiDiscardedMediaObjects(input.siteId, PHI_MEDIA_DISCARD_DRAIN_LIMIT);
  const objects = new Map<string, PhiDiscardedMediaObject>();
  for (const object of [...(input.objects ?? []), ...pending]) {
    objects.set(object.id, object);
  }
  if (objects.size === 0) {
    return 0;
  }

  const cleared: string[] = [];
  for (const object of objects.values()) {
    const profile = await getMediaStorageProfile(input.siteId, object.storageProfileId);
    if (!profile) {
      // The Profile is gone, so this key can no longer be resolved to a store. Keeping the note would
      // mean retrying something that has no way of ever succeeding.
      cleared.push(object.id);
      continue;
    }
    try {
      const storage = await createPhisMediaStorageServiceForProfile(profile, input.siteKey);
      await storage.deleteObject(object.storageKey);
      cleared.push(object.id);
    } catch {
      // Left standing deliberately: the next deletion on this Site picks it up again.
    }
  }
  await forgetPhiDiscardedMediaObjects(cleared);
  return cleared.length;
}

/**
 * Removes a Media Asset and everything that stands behind it: the derived variants, the file, the row.
 *
 * One implementation because dropping the row alone looks like a complete deletion and is not. It gives
 * the bytes back to the Space's figures while leaving them in the store, and the storage key goes with
 * the row -- so afterwards nothing anywhere can find the object again. Nothing about the result looks
 * wrong: the Asset is gone from every listing, the quota is right, and only the bucket knows better.
 *
 * The rows go in one transaction, which also writes down what the store still holds. Only then is the
 * store touched, and a failure there is a note that stays rather than a file that is lost track of.
 */
export async function deleteStoredPhiMediaAsset(asset: MediaAssetRecord, siteKey?: string | null) {
  const client = await getPool().connect();
  let discarded;
  try {
    await client.query("BEGIN");
    discarded = await discardPhiMediaAssets(client, { siteId: asset.siteId, assetIds: [asset.id] });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await drainPhiDiscardedMediaObjects({
    siteId: asset.siteId,
    siteKey,
    objects: discarded.objects,
  });
  return discarded.assetIds.length > 0;
}
