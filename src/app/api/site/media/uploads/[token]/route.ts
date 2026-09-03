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
import { PHIS_CMS_AREA_KEYS } from "@/lib/constants/cms-areas";
import {
  isPhiMediaUploadBodyProxied,
  PhiMediaUploadSessionStatus,
} from "@/lib/media-upload-sessions";
import {
  PhiMediaUploadAbort,
  watchPhiMediaUploadBody,
} from "@/lib/media-upload-stream";
import { requireMediaSpaceWriteContext } from "@/lib/guards/site-media-api";
import { requireSiteFromRequest } from "@/lib/site-context";
import { PhiMediaUploadPurpose } from "@/lib/media-upload-sessions";
import { nextMediaError } from "../_helpers";
import { PHIS_AREA_HEADER } from "@/lib/constants/http-headers";

export const dynamic = "force-dynamic";

function normalizeAreaKey(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return PHIS_CMS_AREA_KEYS.includes(normalized as (typeof PHIS_CMS_AREA_KEYS)[number])
    ? normalized
    : null;
}

/** The shell the call came from, which only the Client can say. */
function resolveRequestArea(request: NextRequest) {
  return normalizeAreaKey(request.headers.get(PHIS_AREA_HEADER));
}


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

  /*
   * From here the body is watched, because `expires_at` is the wrong instrument for this.
   *
   * The reservation's expiry bounds a whole upload and is checked before one starts. It says nothing
   * about a Client that walks away or falls silent halfway through: that session is valid, and without
   * this Core would hold the request, the connection and the reservation open on the strength of a
   * socket nobody is writing to.
   */
  const watch = watchPhiMediaUploadBody(request.body, { clientSignal: request.signal });

  try {
    await updateMediaUploadSessionByToken(token, {
      status: PhiMediaUploadSessionStatus.Uploading,
    });

    const stored = await storageService.putObjectStream({
      storageKey: session.stagingStorageKey,
      body: watch.body,
      contentType: session.contentType,
      metadata: {
        token: session.token,
        siteKey: site.key,
        filename: session.filename,
      },
      signal: watch.signal,
    });

    if (stored.byteSize !== session.sizeBytes) {
      await abortMediaUploadSessionByToken(token);
      await storageService.deleteObject(session.stagingStorageKey).catch(() => {});
      return nextMediaError("upload_size_mismatch", "Upload size mismatch.", 400);
    }

    /*
     * What the Provider can attest, which is not the same as what it returned.
     *
     * Taken from `checksum` rather than `etag`: the ETag is an HTTP cache validator that each Provider
     * fills as it likes, and reading it as a content hash is how an MD5 gets recorded as a SHA-256. A
     * Provider with nothing to attest says so, and null is recorded rather than a number that invites a
     * comparison.
     *
     * Whether it makes this object a duplicate is finalize's judgement, which every plan passes through.
     */
    const checksum = stored.checksum ?? null;

    await updateMediaUploadSessionByToken(token, {
      status: PhiMediaUploadSessionStatus.Uploaded,
      checksumAlgorithm: checksum?.algorithm ?? null,
      checksumValue: checksum?.value ?? null,
      uploadedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      token,
      status: "uploaded",
      byteSize: stored.byteSize,
      checksum,
    });
  } catch (uploadError) {
    // The same teardown whichever way the body ended: the reservation goes back and the torn object
    // goes away. Only what is reported about it differs.
    await abortMediaUploadSessionByToken(token);
    await storageService.deleteObject(session.stagingStorageKey).catch(() => {});

    const abortedBy = watch.abortedBy();
    const meta = {
      originalName: session.filename,
      contentType: session.contentType,
      sizeBytes: session.sizeBytes,
      storageKey: session.stagingStorageKey,
      receivedBytes: watch.receivedBytes(),
    };

    /*
     * An abandoned upload is not a Server fault, and filing it as one is not a harmless overstatement.
     * A closed tab is the most common thing that happens to an upload; at `error` it would be the
     * loudest line in the log and would bury the faults somebody has to act on. What it is worth
     * instead is its rate, and that needs an event of its own to be countable at all.
     *
     * The silence is kept apart from the departure for the same reason in the other direction: it is
     * the only one of the two that can also mean the timeout is set too tight for an honest slow
     * network, and that is a question nobody can ask of a log that calls both "failed".
     */
    if (abortedBy) {
      const stalled = abortedBy === PhiMediaUploadAbort.Stalled;
      logRuntimeEvent(stalled ? "warn" : "info", stalled ? "media.upload.stalled" : "media.upload.abandoned", {
        area: resolveRequestArea(request),
        userId: authSession.userId,
        message: stalled
          ? "Upload stalled: no bytes arrived before the transfer timed out."
          : "Upload abandoned: the client went away before the body was complete.",
        siteKey: site.key,
        method: request.method,
        path: request.nextUrl.pathname,
        meta,
      });
      return nextMediaError(
        stalled ? "upload_stalled" : "upload_abandoned",
        stalled ? "Upload stalled." : "Upload abandoned.",
        408,
      );
    }

    logRuntimeEvent("error", "media.upload.failed", {
      area: resolveRequestArea(request),
      userId: authSession.userId,
      message: uploadError instanceof Error ? uploadError.message : "Upload failed.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      error: normalizeLogThrowable(uploadError),
      meta,
    });
    return NextResponse.json(
      {
        error: "upload_failed",
        message: uploadError instanceof Error ? uploadError.message : "Upload failed.",
      },
      { status: 500 },
    );
  } finally {
    // A completed upload leaves a timer armed for as long as the timeout, otherwise.
    watch.release();
  }
}
