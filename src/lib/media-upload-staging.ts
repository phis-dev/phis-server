import { getMediaStorageProfile } from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";

/**
 * Removes the staging object of one abandoned upload session.
 *
 * For the session the caller has in hand, and only that one. `releaseExpiredMediaUploadSessions`
 * deliberately leaves storage alone, and its reason holds: sweeping other sessions means opening
 * Providers the sweeping request has no business opening, which is a bucket lifecycle rule's job or an
 * operator's. None of that applies to a session whose Profile, key and authority a request already
 * carries -- and that is the one abandonment Core is actually told about, so leaving its object behind
 * would mean the only failure Core can see is the one it goes on paying for.
 *
 * Its own function because a multipart plan will want the same moment for more than a delete: an
 * incomplete multipart upload has to be aborted, or it is billed while being invisible to a listing.
 *
 * Three answers, and the difference between the last two matters to whoever reads the log:
 *
 * - `true` -- the object was there and is gone.
 * - `false` -- there was nothing to remove, which is ordinary. A presigned body that never reached the
 *   endpoint staged nothing at all.
 * - `null` -- it could not be reached: no Profile, or a Provider that refused or timed out. The object
 *   may still exist and nothing will come back for it.
 */
export async function removePhiMediaUploadStagingObject(input: {
  siteId: number;
  siteKey: string;
  storageProfileId: number;
  stagingStorageKey: string;
}): Promise<boolean | null> {
  const stagingStorageKey = input.stagingStorageKey?.trim();
  if (!stagingStorageKey) return false;

  const profile = await getMediaStorageProfile(input.siteId, input.storageProfileId).catch(() => null);
  if (!profile) return null;

  try {
    const storage = await createPhisMediaStorageServiceForProfile(profile, input.siteKey);
    return await storage.deleteObject(stagingStorageKey);
  } catch {
    return null;
  }
}
