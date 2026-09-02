import { NextRequest, NextResponse } from "next/server";

import {
  abortMediaUploadSessionByToken,
  deleteMediaUploadSessionByToken,
  getMediaUploadSessionByToken,
  updateMediaUploadSessionByToken,
} from "@/db/media";
import { getSessionFromRequest } from "@/db/user-sessions";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import {
  isPhiMediaUploadBodyProxied,
  PhiMediaUploadSessionStatus,
} from "@/lib/media-upload-sessions";
import { requireMediaSpaceWriteContext } from "@/lib/guards/site-media-api";
import { requireSiteFromRequest } from "@/lib/site-context";
import { PhiMediaUploadPurpose } from "@/lib/media-upload-sessions";
import { nextMediaError } from "../_helpers";

export const dynamic = "force-dynamic";

export async function PUT(
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
   * Who may deliver this body, and it is not always the Media permission system that answers.
   *
   * An upload into an Add-on Space was already authorised where it was asked for: `assets:v1` put it to
   * the Add-on's own row authority, which is what governs a file hanging off that row. Sending it
   * through the Media Space write check as well would ask a second, unrelated question -- may this
   * person write into a Space that is not a person's at all -- and the answer would be no for everyone.
   *
   * What still holds for both is the session's own actor, checked below. The reservation names who it
   * was made for, and only they may redeem it.
   */
  const site = staged?.purpose === PhiMediaUploadPurpose.AddonAsset
    ? await requireSiteFromRequest(request)
    : await (async () => {
        const context = await requireMediaSpaceWriteContext(request, async () => staged?.spaceId ?? null);
        return context.error ? null : context.site;
      })();
  if (!site) {
    // The same answer whichever branch declined, because the two together are what a caller would
    // otherwise use this route to tell apart.
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

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await abortMediaUploadSessionByToken(token);
    return nextMediaError("upload_session_expired", "Upload session expired.", 410);
  }

  // Core receives a body only for the plan that says so. On any other plan the Client was told to
  // deliver elsewhere, and a body arriving here would be a second, unaccounted copy.
  if (!isPhiMediaUploadBodyProxied(session.uploadPlanKind)) {
    return nextMediaError(
      "upload_plan_mismatch",
      "This upload session does not deliver its body through the Server.",
      409,
    );
  }

  if (session.status === PhiMediaUploadSessionStatus.Completed) {
    // A completed session's reservation has already moved to used_bytes; do not release it again.
    await deleteMediaUploadSessionByToken(token);
    return nextMediaError("upload_session_completed", "Upload session already completed.", 410);
  }

  if (!request.body) {
    await abortMediaUploadSessionByToken(token);
    return nextMediaError("invalid_upload_body", "Invalid upload body.", 400);
  }

  const profile = await getMediaStorageProfile(site.id, session.storageProfileId);
  if (!profile) return nextMediaError("storage_profile_unavailable", "Storage Profile is unavailable.", 503);
  const storageService = await createPhisMediaStorageServiceForProfile(profile, site.key);

  try {
    await updateMediaUploadSessionByToken(token, {
      status: PhiMediaUploadSessionStatus.Uploading,
    });

    const stored = await storageService.putObjectStream({
      storageKey: session.stagingStorageKey,
      body: request.body,
      contentType: session.contentType,
      metadata: {
        token: session.token,
        siteKey: site.key,
        filename: session.filename,
      },
    });

    if (stored.byteSize !== session.sizeBytes) {
      await abortMediaUploadSessionByToken(token);
      await storageService.deleteObject(session.stagingStorageKey).catch(() => {});
      return nextMediaError("upload_size_mismatch", "Upload size mismatch.", 400);
    }

    // What the object is, rather than how it arrived, decides whether it is a duplicate -- and only
    // the plan that streams through Core arrives here at all. That judgement therefore belongs to
    // finalize, which every plan passes through.
    const checksumSha256 = stored.etag || null;

    await updateMediaUploadSessionByToken(token, {
      status: PhiMediaUploadSessionStatus.Uploaded,
      checksumSha256,
      uploadedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      token,
      status: "uploaded",
      byteSize: stored.byteSize,
      checksumSha256,
    });
  } catch (uploadError) {
    await abortMediaUploadSessionByToken(token);
    await storageService.deleteObject(session.stagingStorageKey).catch(() => {});
    logRuntimeEvent("error", "media.upload.failed", {
      message: uploadError instanceof Error ? uploadError.message : "Upload failed.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      error: normalizeLogThrowable(uploadError),
      meta: {
        originalName: session.filename,
        contentType: session.contentType,
        sizeBytes: session.sizeBytes,
        storageKey: session.stagingStorageKey,
      },
    });
    return NextResponse.json(
      {
        error: "upload_failed",
        message: uploadError instanceof Error ? uploadError.message : "Upload failed.",
      },
      { status: 500 },
    );
  }
}
