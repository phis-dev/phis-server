import "server-only";

import {
  deleteImageAssetVariantsByAssetId,
  deleteMediaAssetBySite,
  type MediaAssetRecord,
} from "@/db/media";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";

/**
 * Removes a Media Asset and everything that stands behind it: the derived variants, the file, the row.
 *
 * One implementation because dropping the row alone looks like a complete deletion and is not. It gives
 * the bytes back to the Space's figures while leaving them in the store, and the storage key goes with
 * the row -- so afterwards nothing anywhere can find the object again. Nothing about the result looks
 * wrong: the Asset is gone from every listing, the quota is right, and only the bucket knows better.
 *
 * The order is variants, file, row, and only the last one is reported. Deleting an object the store no
 * longer has is the state the caller asked for, and refusing over it would keep a row whose file is
 * already gone -- which is the one outcome from which there is no way back.
 *
 * The profile is taken from the Asset and from each variant rather than from the Space, because a Space
 * that changed its default Storage Profile still has to be able to delete what it wrote under the old
 * one.
 */
export async function deleteStoredPhiMediaAsset(asset: MediaAssetRecord, siteKey?: string | null) {
  const variants = await deleteImageAssetVariantsByAssetId(asset.id);
  await Promise.all(variants.map(async (variant) => {
    const profile = await getMediaStorageProfile(asset.siteId, variant.storageProfileId);
    if (!profile) return;
    const storage = await createPhisMediaStorageServiceForProfile(profile, siteKey);
    await storage.deleteObject(variant.storageKey).catch(() => {});
  }));

  const profile = await getMediaStorageProfile(asset.siteId, asset.storageProfileId);
  if (profile) {
    const storage = await createPhisMediaStorageServiceForProfile(profile, siteKey);
    await storage.deleteObject(asset.storageKey).catch(() => {});
  }

  return deleteMediaAssetBySite(asset.siteId, asset.spaceId, asset.id);
}
