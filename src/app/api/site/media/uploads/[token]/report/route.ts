import { NextRequest, NextResponse } from "next/server";

import {
  abortMediaUploadSessionByToken,
  getMediaUploadSessionByToken,
  updateMediaUploadSessionByToken,
} from "@/db/media";
import { getSessionFromRequest } from "@/db/user-sessions";
import { logRuntimeEvent } from "@/lib/log";
import { discardPhiMediaUploadStaging } from "@/lib/media-upload-staging";
import {
  isPhiMediaUploadAssembledFromParts,
  PhiMediaUploadPurpose,
  PhiMediaUploadSessionStatus,
} from "@/lib/media-upload-sessions";
import { requireMediaSpaceWriteContext } from "@/lib/guards/site-media-api";
import { requireSiteFromRequest } from "@/lib/site-context";
import { nextMediaError } from "../../_helpers";

/**
 * Where a Client says an upload it was asked to deliver elsewhere did not arrive.
 *
 * A presigned plan is handed to the browser and then leaves Core's sight entirely. When the browser
 * cannot deliver -- an endpoint it has no route to, a certificate it will not accept, mixed content it
 * refuses to send at all -- nothing reaches any server, so there is nothing to log and the session
 * simply sits at Pending until it expires. That is the one failure the operator cannot see, and it is
 * exactly the one an unreachable Provider produces.
 *
 * This route does not judge the reason. It records what the Client claims, releases the reservation,
 * and leaves a journal entry the Site's log can be read for; a Client that lies about it can only
 * abandon its own session, which it could do by saying nothing at all.
 *
 * One reason is the exception, and it is the opposite of a teardown. `interrupted` says the page carrying
 * the body went away while it was still in flight, and where that body was travelling in parts the parts
 * that arrived are at the Provider, paid for and perfectly good. Such a session keeps its row, its
 * reservation and its parts, and the next `uploads/init` for the same file carries it on instead of asking
 * for those bytes again. Every other reason, and `interrupted` on a plan that leaves nothing behind, is
 * still the teardown: row gone, reservation released, staged remains discarded.
 */

export const dynamic = "force-dynamic";

const REPORTABLE_REASONS = new Set([
  /** The browser never reached the storage endpoint: no response, no status. */
  "storage_unreachable",
  /** The storage endpoint answered, and refused. */
  "storage_rejected",
  /** A person stopped it. */
  "cancelled",
  /**
   * The page carrying the body went away while it was still in flight.
   *
   * Told apart from `cancelled` because the two call for opposite things. A person who stops an upload has
   * decided against it, and what was sent is waste to be cleared. A page that is reloaded, crashes or is
   * closed decided nothing -- and where the body was travelling in parts, the parts that arrived are the
   * expensive half of the work and are perfectly good. Reported as one word until now, which meant every
   * reload threw them away.
   */
  "interrupted",
  /** Anything the Client could not place in the four above. */
  "client_error",
]);

const MAX_DETAIL_LENGTH = 512;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> | { token: string } },
) {
  const resolvedParams = await Promise.resolve(params);
  const token = resolvedParams.token?.trim() || "";
  if (!token) {
    return nextMediaError("missing_upload_token", "Missing upload token.", 400);
  }

  const staged = await getMediaUploadSessionByToken(token);

  /*
   * Who may report on this body, split the way the delivery route splits it.
   *
   * An upload into an Add-on Space was authorised where it was asked for, by the Add-on's own row
   * authority. Its Space is not a person's, so the Media Space write check answers no to everyone --
   * and a Client that cannot report is one whose failed presigned upload leaves nothing in the log at
   * all, which is the single case this route exists for. The session's own actor still decides, below.
   */
  const site = staged?.purpose === PhiMediaUploadPurpose.AddonAsset
    ? await requireSiteFromRequest(request)
    : await (async () => {
        const context = await requireMediaSpaceWriteContext(request, async () => staged?.spaceId ?? null);
        return context.error ? null : context.site;
      })();
  if (!site) {
    // The same answer whichever branch declined, for the reason the delivery route gives: the two
    // together are what a caller would otherwise use this route to tell apart.
    return nextMediaError("upload_session_not_found", "Upload session not found.", 404);
  }

  const session = staged;
  if (!session || session.siteId !== site.id) {
    return nextMediaError("upload_session_not_found", "Upload session not found.", 404);
  }

  const authSession = await getSessionFromRequest(request, site.id);
  if (!authSession) {
    return nextMediaError("authentication_required", "Authentication required.", 401);
  }
  if (session.actorUserId !== authSession.userId) {
    return nextMediaError("upload_session_not_found", "Upload session not found.", 404);
  }

  // A finished session is not a failed one, and its reservation has already moved to used_bytes.
  if (session.status === PhiMediaUploadSessionStatus.Completed) {
    return nextMediaError("upload_session_completed", "Upload session already completed.", 410);
  }

  const payload = (await request.json().catch(() => null)) as
    | { reason?: unknown; detail?: unknown }
    | null;
  const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
  if (!REPORTABLE_REASONS.has(reason)) {
    return nextMediaError("invalid_upload_report", "Unknown upload failure reason.", 400);
  }
  const detail = typeof payload?.detail === "string"
    ? payload.detail.trim().slice(0, MAX_DETAIL_LENGTH)
    : null;

  /*
   * The one report that is not a teardown.
   *
   * A body delivered in parts leaves them at the Provider, and a page that went away mid-upload is the
   * case they exist for: the reload cost nothing, the parts are still good, and the next attempt at the
   * same file joins this assembly instead of paying for those bytes twice. So the row stays -- with its
   * reservation, because the parts really are held -- and only its status changes to say what happened.
   *
   * `expires_at` is not moved. The session's life is the reservation's life, and a report that extended it
   * would let anybody hold a Space's capacity indefinitely by interrupting an upload over and over. What
   * was not carried on inside that window is swept like any other expired session, and the storage's own
   * abort rule reaches the parts if the sweep never does.
   *
   * Only an assembly, and only one the Provider named: without that name nothing can be continued *or*
   * aborted later, so a session lacking it is torn down here like any other failure.
   */
  if (
    reason === "interrupted"
    && isPhiMediaUploadAssembledFromParts(session.uploadPlanKind)
    && session.providerUploadId
  ) {
    await updateMediaUploadSessionByToken(token, {
      status: PhiMediaUploadSessionStatus.Interrupted,
    });
    logRuntimeEvent("info", "media.upload.interrupted", {
      message: `Upload session ${token} was interrupted with its parts kept for a later attempt.`,
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      userId: authSession.userId,
      meta: {
        reason,
        detail,
        spaceId: session.spaceId,
        storageProfileId: session.storageProfileId,
        originalName: session.filename,
        sizeBytes: session.sizeBytes,
        // Until this moment, so an operator can see how long the parts may still be taken over for.
        expiresAt: session.expiresAt,
      },
    });
    return NextResponse.json({ token, status: "interrupted", resumable: true });
  }

  await abortMediaUploadSessionByToken(token);

  /*
   * After the abort and never before it: a Provider that cannot be reached must not also keep the
   * reservation. The result travels into the entry below rather than being swallowed, because `null`
   * there means an object may still be sitting in a bucket with nothing coming back for it.
   */
  const stagingRemoved = await discardPhiMediaUploadStaging({
    siteId: site.id,
    siteKey: site.key,
    storageProfileId: session.storageProfileId,
    stagingStorageKey: session.stagingStorageKey,
    // Set only for a multipart plan, and then the remains are parts to abort rather than an object.
    providerUploadId: session.providerUploadId,
  });

  logRuntimeEvent(reason === "cancelled" ? "info" : "error", "media.upload.client_failed", {
    message: `Client reported ${reason} for upload session ${token}.`,
    siteKey: site.key,
    method: request.method,
    path: request.nextUrl.pathname,
    userId: authSession.userId,
    meta: {
      reason,
      detail,
      spaceId: session.spaceId,
      storageProfileId: session.storageProfileId,
      uploadPlanKind: session.uploadPlanKind,
      stagingStorageKey: session.stagingStorageKey,
      // `null` is the one that needs reading: the object may still be there and nothing will return for it.
      stagingRemoved,
      originalName: session.filename,
      contentType: session.contentType,
      sizeBytes: session.sizeBytes,
    },
  });

  return NextResponse.json({ token, status: "aborted", reason });
}
