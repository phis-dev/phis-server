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
  if (!stagingStorageKey) return false;

  const profile = await getMediaStorageProfile(input.siteId, input.storageProfileId).catch(() => null);
  if (!profile) return null;

  try {
    const storage = await createPhisMediaStorageServiceForProfile(profile, input.siteKey);
    return await discardStagingWith(storage, input);
  } catch {
    return null;
  }
}

/** The same discard, against a Provider the caller already has open. */
async function discardStagingWith(
  storage: { deleteObject(key: string): Promise<boolean>; completeUpload(input: {
    storageKey: string; completion?: unknown;
  }): Promise<unknown> },
  input: { stagingStorageKey: string; providerUploadId?: string | null },
): Promise<boolean> {
  const stagingStorageKey = input.stagingStorageKey.trim();
  const providerUploadId = input.providerUploadId?.trim();

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
}

/**
 * Cleans up after the sessions an expiry sweep just released, in one pass over one Provider.
 *
 * This is the case the sweep used to leave behind. It deletes the rows -- which it must, because the
 * reservation is what an upload is waiting for -- and the row is the only record of where the remains are.
 * So the remains are handed here while the request still has the Space's Provider open, which is the whole
 * reason this can be done at all without a request opening Providers it has no business opening.
 *
 * Only the sessions on the Profile the caller opened. A session can name another one, but only for as long
 * as a session may live after an operator changed the Space's Profile -- and the objects then sit in the
 * other storage, whose own lifecycle rule is what reaches them. Resolving a second Provider here would mean
 * reading another secret on behalf of an upload that has nothing to do with it.
 *
 * Answers how many were cleaned up, and never throws: it runs after the response, so a failure has nobody
 * to tell. A storage that refused leaves its objects to the lifecycle rule, which is why one is written.
 */
export async function discardReleasedPhiMediaUploadStaging(input: {
  siteKey: string;
  storageProfileId: number;
  profile: Parameters<typeof createPhisMediaStorageServiceForProfile>[0];
  sessions: readonly {
    storageProfileId: number;
    stagingStorageKey: string;
    providerUploadId: string | null;
  }[];
}): Promise<{ discarded: number; skipped: number; failed: number }> {
  const mine = input.sessions.filter((session) =>
    session.storageProfileId === input.storageProfileId && session.stagingStorageKey.trim().length > 0);
  const skipped = input.sessions.length - mine.length;
  if (mine.length === 0) return { discarded: 0, skipped, failed: 0 };

  let storage;
  try {
    storage = await createPhisMediaStorageServiceForProfile(input.profile, input.siteKey);
  } catch {
    return { discarded: 0, skipped, failed: mine.length };
  }

  let discarded = 0;
  let failed = 0;
  for (const session of mine) {
    try {
      await discardStagingWith(storage, session);
      discarded += 1;
    } catch {
      // One object that could not be removed must not stop the others; the rule catches what is left.
      failed += 1;
    }
  }
  return { discarded, skipped, failed };
}
