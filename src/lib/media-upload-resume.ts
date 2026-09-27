import "server-only";

import {
  abortMediaUploadSessionByToken,
  findResumableMediaUploadSession,
  updateMediaUploadSessionByToken,
} from "@/db/media";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import type { PhisMediaStorageService } from "@/lib/media-storage";
import type { PhiMediaUploadResumption } from "@/lib/media-storage";
import { PhiMediaUploadSessionStatus } from "@/lib/media-upload-sessions";

/**
 * Taking over an upload whose page went away, instead of asking for the bytes again.
 *
 * A body delivered in parts already survives a part that fails -- that part repeats alone. What it did not
 * survive was the page: the plan lived in the tab, and when the tab said it was leaving, the assembly was
 * aborted and every part that had arrived was thrown away. For the sizes multipart exists for that is the
 * expensive half of the work, and a reload is the most ordinary thing that happens to a browser.
 *
 * So this is looked for at `uploads/init` and nowhere else, and that is the whole of the design decision.
 * Init is where a Client says which file it is about to send and, since the digest exists, what that file
 * *is* -- and the digest is proof rather than a resemblance. There is no second route to ask, nothing kept
 * in the browser that could outlive the row it describes, and no question put to the person: continuing
 * produces the same object as starting over, verified byte for byte, and only faster.
 *
 * Identity is the composite, and nothing weaker. The parts already at the Provider are bytes somebody
 * asserted once; joining them to a body that is not the same file would assemble an object out of two
 * different files, and its digest would be recorded as true of the result. Which is why a missing digest
 * means no resumption at all rather than a match on name and size.
 */

export type PhiMediaUploadResumed = {
  token: string;
  plan: PhiMediaUploadResumption["plan"];
  /** The parts the storage already holds, which the Client has to name again at finalize. */
  uploaded: PhiMediaUploadResumption["uploaded"];
  expiresAt: string;
  status: number;
  /** What was still to be sent when the plan was issued, for the log and for the response. */
  remainingParts: number;
};

/**
 * Finds the interrupted upload this one would be carrying on, and hands back the rest of its plan.
 *
 * `null` means there is nothing to carry on, which is the ordinary answer and not a failure: no such
 * session, another Storage Profile, or a Provider that no longer holds the assembly. The caller goes on to
 * open a fresh session, which is what it would have done anyway.
 *
 * Deliberately before any capacity is reserved. The session being taken over is still holding its own
 * reservation -- the parts are really there -- so reserving again would charge the Space twice for one body
 * and hand back capacity only when the abandoned row expired.
 */
export async function findPhiMediaUploadToResume(input: {
  siteId: number;
  siteKey: string;
  spaceId: number;
  actorUserId: number;
  filename: string;
  sizeBytes: number;
  /** The Profile this Space uses now. A session naming another one is not resumable here; see below. */
  storageProfileId: number;
  /** The digest the plan would record, which for an assembly is the composite of the part digests. */
  checksum: { algorithm: string; value: string } | null;
  /** The Client's part digests, in part order, so the parts still missing can be signed. */
  partChecksums: readonly string[];
  /** Already open for this Space's Profile, which is the only one this may reach into. */
  storage: PhisMediaStorageService;
  /** Where this attempt says the Asset belongs, which may not be where the first attempt said. */
  folderId: number | null;
  presentationFlags: number;
  meta: Record<string, unknown> | null;
}): Promise<PhiMediaUploadResumed | null> {
  /*
   * No composite, no resumption. The other digest shapes cannot appear here -- a body small enough for a
   * whole-object digest is one request and leaves nothing to continue -- and no digest at all means the
   * only evidence that these parts belong to this file does not exist.
   */
  if (!input.checksum || input.checksum.algorithm !== "sha256-composite" || input.partChecksums.length === 0) {
    return null;
  }

  const session = await findResumableMediaUploadSession({
    siteId: input.siteId,
    spaceId: input.spaceId,
    actorUserId: input.actorUserId,
    filename: input.filename,
    sizeBytes: input.sizeBytes,
    checksumAlgorithm: input.checksum.algorithm,
    checksumValue: input.checksum.value,
  });
  if (!session || !session.providerUploadId) return null;

  /*
   * A session on another Profile is left alone, for the reason the expiry sweep gives: reaching it means
   * opening a storage on behalf of an upload that has nothing to do with the one being asked for, and
   * reading that Profile's secret to do it. It can only happen for as long as one session may live after an
   * operator changed the Space's Profile, and the ordinary path -- a fresh upload to the current storage --
   * is the right answer in that window anyway.
   */
  if (session.storageProfileId !== input.storageProfileId) return null;

  let resumption: PhiMediaUploadResumption | null = null;
  try {
    resumption = await input.storage.resumeUploadPlan({
      storageKey: session.stagingStorageKey,
      uploadId: session.providerUploadId,
      contentType: session.contentType,
      sizeBytes: session.sizeBytes,
      expiresAt: session.expiresAt,
      partChecksums: input.partChecksums,
    });
  } catch (error) {
    /*
     * The storage could not be asked. Not fatal to this request -- a fresh upload is still perfectly
     * possible and is what happens next -- but it is worth a line, because the alternative is an upload
     * that silently starts from the beginning and a person wondering why.
     */
    logRuntimeEvent("warn", "media.upload.resume_unavailable", {
      message: `The storage could not say what upload session ${session.token} still holds.`,
      siteKey: input.siteKey,
      error: normalizeLogThrowable(error),
      meta: { spaceId: input.spaceId, storageProfileId: session.storageProfileId },
    });
    return null;
  }

  /*
   * The assembly is gone: aborted, or reached by the storage's own abort rule. Then the row is holding a
   * reservation for parts that do not exist, and nothing will ever come back for it -- so it is torn down
   * here rather than left to expire. The caller reserves for the fresh upload afterwards, which is why this
   * order matters: releasing first means a Space at its limit can still take the retry.
   */
  if (!resumption) {
    await abortMediaUploadSessionByToken(session.token);
    logRuntimeEvent("info", "media.upload.resume_vanished", {
      message: `Upload session ${session.token} was interrupted, but the storage no longer holds its parts.`,
      siteKey: input.siteKey,
      meta: {
        spaceId: input.spaceId,
        storageProfileId: session.storageProfileId,
        originalName: session.filename,
        sizeBytes: session.sizeBytes,
      },
    });
    return null;
  }

  /*
   * Taken over, and marked as such in the same step. The status is what keeps two pages out of one
   * assembly: only an interrupted session is offered, so from here a second attempt at the same file finds
   * nothing and opens its own upload rather than writing the same part numbers.
   *
   * The destination comes from this attempt rather than the first one. A person who drops the same file
   * into another Folder means that Folder; the parts are the only thing being reused.
   *
   * `expires_at` is untouched. The reservation's life is the session's life, and continuing an upload must
   * not be a way to hold a Space's capacity open indefinitely.
   */
  const taken = await updateMediaUploadSessionByToken(session.token, {
    status: PhiMediaUploadSessionStatus.Uploading,
    folderId: input.folderId,
    presentationFlags: input.presentationFlags,
    meta: input.meta,
  });
  if (!taken) return null;

  return {
    token: session.token,
    plan: resumption.plan,
    uploaded: resumption.uploaded,
    expiresAt: session.expiresAt,
    status: taken.status,
    remainingParts: resumption.plan.parts.length,
  };
}
