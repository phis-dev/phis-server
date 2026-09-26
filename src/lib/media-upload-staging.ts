import { getMediaStorageProfile } from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";

/**
 * Throws away whatever one abandoned upload session left at its Provider.
 *
 * For the session the caller has in hand, and only that one. `releaseExpiredMediaUploadSessions`
 * deliberately leaves storage alone, and its reason holds: sweeping other sessions means opening
 * Providers the sweeping request has no business opening, which is a bucket lifecycle rule's job or an
 * operator's. None of that applies to a session whose Profile, key and authority a request already
 * carries -- and that is the one abandonment Core is actually told about, so leaving its remains behind
 * would mean the only failure Core can see is the one it goes on paying for.
 *
 * What "remains" are depends on the plan, and the difference is not cosmetic:
 *
 * - A single `PUT`, proxied or presigned, either wrote a staging object or did not. That object is
 *   deleted.
 * - A multipart upload wrote *parts*, and there is no object to delete: until it is completed the
 *   assembly exists only at the Provider, where it is billed and where a listing does not show it. It has
 *   to be aborted, which is why the session keeps `provider_upload_id` -- a Client that has gone away
 *   cannot be asked what it was called.
 *
 * Three answers, and the difference between the last two matters to whoever reads the log:
 *
 * - `true` -- the object was there and is gone, or the assembly was aborted.
 * - `false` -- there was nothing to remove, which is ordinary. A presigned body that never reached the
 *   endpoint staged nothing at all.
 * - `null` -- it could not be reached: no Profile, or a Provider that refused or timed out. What was
 *   there may still be there, and nothing will come back for it.
 */
export async function discardPhiMediaUploadStaging(input: {
  siteId: number;
  siteKey: string;
  storageProfileId: number;
  stagingStorageKey: string;
  /** Set only for a plan the Provider is assembling from parts. */
  providerUploadId?: string | null;
}): Promise<boolean | null> {
  const stagingStorageKey = input.stagingStorageKey?.trim();
  const providerUploadId = input.providerUploadId?.trim();
  if (!stagingStorageKey) return false;

  const profile = await getMediaStorageProfile(input.siteId, input.storageProfileId).catch(() => null);
  if (!profile) return null;

  try {
    const storage = await createPhisMediaStorageServiceForProfile(profile, input.siteKey);

    if (providerUploadId) {
      /*
       * A completion naming no parts is how the storage contract spells "abort": the Provider discards
       * what it was holding and answers with nothing, because nothing was assembled. The `null` it
       * returns is therefore success here, and only a throw is the unreachable case.
       */
      await storage.completeUpload({
        storageKey: stagingStorageKey,
        completion: { uploadId: providerUploadId, parts: [] },
      });
      return true;
    }

    return await storage.deleteObject(stagingStorageKey);
  } catch {
    return null;
  }
}
