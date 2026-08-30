import { NextRequest, NextResponse } from "next/server";

import {
  abortMediaUploadSessionByToken,
  getMediaUploadSessionByToken,
} from "@/db/media";
import { getSessionFromRequest } from "@/db/user-sessions";
import { logRuntimeEvent } from "@/lib/log";
import { PhiMediaUploadSessionStatus } from "@/lib/media-upload-sessions";
import { requireMediaSpaceWriteContext } from "@/lib/guards/site-media-api";
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
 */

export const dynamic = "force-dynamic";

const REPORTABLE_REASONS = new Set([
  /** The browser never reached the storage endpoint: no response, no status. */
  "storage_unreachable",
  /** The storage endpoint answered, and refused. */
  "storage_rejected",
  /** A person stopped it. */
  "cancelled",
  /** Anything the Client could not place in the three above. */
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

  const { site, error } = await requireMediaSpaceWriteContext(request, async () => {
    const staged = await getMediaUploadSessionByToken(token);
    return staged?.spaceId ?? null;
  });
  if (error) {
    return error;
  }

  const session = await getMediaUploadSessionByToken(token);
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

  await abortMediaUploadSessionByToken(token);

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
      originalName: session.filename,
      contentType: session.contentType,
      sizeBytes: session.sizeBytes,
    },
  });

  return NextResponse.json({ token, status: "aborted", reason });
}
