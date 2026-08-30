import { NextRequest, NextResponse } from "next/server";

import {
  createMediaUploadSession,
  getMediaFolderBySiteAndId,
  releaseExpiredMediaUploadSessions,
} from "@/db/media";
import {
  releaseMediaSpaceReservation,
  reserveMediaSpaceQuota,
  ensureSiteMediaConfig,
  isPhiMediaContentAllowedInSpace,
  isPhiMediaObjectSizeAllowed,
  resolveAuthorizedMediaSpace,
} from "@/db/media-spaces";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { nextMediaSpaceError } from "@/lib/media-response";
import { getSessionFromRequest } from "@/db/user-sessions";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { logRuntimeEvent } from "@/lib/log";
import {
  createPhiMediaUploadSessionToken,
  PhiMediaUploadSessionStatus,
  resolvePhiMediaUploadPlanKind,
  resolvePhiMediaUploadSessionKind,
} from "@/lib/media-upload-sessions";
import {
  readRequestedMediaSpaceId,
  requireMediaSpaceWriteContext,
} from "@/lib/guards/site-media-api";
import { nextMediaError, readJsonBody } from "../_helpers";
import { normalizeString } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function normalizePositiveNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

function normalizeFlags(value: unknown) {
  if (value == null) {
    return 0;
  }

  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

function normalizeUploadMeta(value: unknown) {
  if (value == null) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 8192) {
      return undefined;
    }

    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function POST(request: NextRequest) {
  const { site, siteWide, error } = await requireMediaSpaceWriteContext(request, async ({ site: ownSite, session }) => {
    // The Space this upload is for, resolved through the same reader the body below uses, so the
    // authority and the destination can never be answered from two different values.
    const requested = await resolveAuthorizedMediaSpace({
      siteId: ownSite.id,
      userId: session.userId,
      requestedSpaceId: readRequestedMediaSpaceId(request),
      intent: "write",
    });
    return requested.ok ? requested.space.id : null;
  });
  if (error) {
    return error;
  }

  const authSession = await getSessionFromRequest(request, site.id);
  if (!authSession) {
    return nextMediaError("authentication_required", "Authentication required.", 401);
  }

  const payload = await readJsonBody(request);
  if (!payload) {
    return nextMediaError("invalid_json_body", "Invalid JSON body.", 400);
  }

  const filename = normalizeString(payload.filename);
  const contentType = normalizeString(payload.contentType);
  const size = normalizePositiveNumber(payload.size);
  const folderId = payload.folderId == null ? null : normalizePositiveNumber(payload.folderId);
  const meta = normalizeUploadMeta(payload.meta);
  const presentationFlags = normalizeFlags(payload.presentationFlags);
  if (!filename) {
    return nextMediaError("missing_filename", "Missing filename.", 400);
  }
  if (!contentType) {
    return nextMediaError("missing_content_type", "Missing content type.", 400);
  }
  if (!size) {
    return nextMediaError("missing_file_size", "Missing file size.", 400);
  }
  if (payload.folderId != null && folderId === null) {
    return nextMediaError("invalid_folder", "Invalid Folder.", 400);
  }
  if (payload.meta != null && meta === undefined) {
    return nextMediaError("invalid_meta", "Invalid media metadata.", 400);
  }
  if (payload.presentationFlags != null && presentationFlags === null) {
    return nextMediaError("invalid_presentation_flags", "Invalid presentation flags value.", 400);
  }

  /*
   * How much fits is a Site question, so it is answered before the Space is even resolved: the answer
   * is the same wherever the file was headed, and a refusal here never holds capacity it will not use.
   */
  const mediaConfig = await ensureSiteMediaConfig(site.id);
  if (!isPhiMediaObjectSizeAllowed(size, mediaConfig)) {
    return nextMediaError(
      "media_asset_too_large",
      `This file is larger than the ${mediaConfig.maxObjectBytes} byte limit for this site.`,
      413,
    );
  }

  const resolution = await resolveAuthorizedMediaSpace({
    // A write is what brings a Group Space into existence.
    intent: "write",
    siteId: site.id,
    siteWide,
    userId: authSession.userId,
    requestedSpaceId: readRequestedMediaSpaceId(request),
  });
  if (!resolution.ok) {
    return nextMediaSpaceError(resolution.reason);
  }
  const { space } = resolution;

  /*
   * What this Space is for, which is a Module question and therefore only answerable once the Space is
   * known. A delegated Space accepts what some active Module declared it for; the Site Space accepts
   * anything, because its authority is a role rather than a list.
   *
   * Still ahead of the reservation, and still only the declared type -- `finalize` is where the bytes
   * get to disagree with what the uploader said they were.
   */
  if (!isPhiMediaContentAllowedInSpace(contentType, space, mediaConfig)) {
    return nextMediaError(
      "content_type_not_allowed",
      "That kind of file does not belong in this Media Space.",
      415,
    );
  }

  const profile = await getMediaStorageProfile(site.id, space.defaultStorageProfileId);
  if (!profile) {
    return nextMediaError("storage_profile_unavailable", "Storage Profile unavailable.", 503);
  }
  if (folderId != null && !await getMediaFolderBySiteAndId(site.id, space.id, folderId)) {
    return nextMediaError("folder_not_found", "Folder not found in the active Media Space.", 404);
  }
  // Maintenance happens at the moment the resource is requested: whoever asks this Space for capacity
  // first hands back the capacity its own expired sessions are still holding.
  await releaseExpiredMediaUploadSessions(space.id);
  if (!await reserveMediaSpaceQuota({ spaceId: space.id, bytes: size })) {
    return nextMediaError("media_quota_exceeded", "Media Space quota exceeded.", 413);
  }
  const storageService = await createPhisMediaStorageServiceForProfile(profile, site.key)
  const token = createPhiMediaUploadSessionToken();
  const kind = resolvePhiMediaUploadSessionKind(contentType);
  const tempStorageKey = storageService.createUploadTempStorageKey({
    siteKey: site.key,
    token,
    originalName: filename,
  });
  const finalStorageKey = storageService.createStorageKey({
    siteKey: site.key,
  });
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
  // How the body is to be delivered is the Provider's to state, not the Client's to assume. Core owns
  // its own route table, so the address it would receive a body at is handed over rather than guessed.
  const plan = await storageService.createUploadPlan({
    token,
    storageKey: tempStorageKey,
    contentType,
    sizeBytes: size,
    expiresAt,
    proxyUploadUrl: `/api/site/media/uploads/${token}`,
  });
  const uploadPlanKind = resolvePhiMediaUploadPlanKind(plan.kind);

  try {
    const uploadSession = await createMediaUploadSession({
      token,
      siteId: site.id,
      actorUserId: authSession.userId,
      spaceId: space.id,
      folderId,
      storageProfileId: profile.id,
      status: PhiMediaUploadSessionStatus.Pending,
      filename,
      contentType,
      sizeBytes: size,
      kind,
      uploadPlanKind,
      meta,
      presentationFlags: presentationFlags ?? 0,
      stagingStorageKey: tempStorageKey,
      finalStorageKey,
      expiresAt,
    });

    if (!uploadSession) {
      // The reservation was taken before the session row; without the row nothing can release it later.
      await releaseMediaSpaceReservation({ spaceId: space.id, bytes: size });
      logRuntimeEvent("error", "media.upload_session.create_failed", {
        message: "Failed to create upload session.",
        siteKey: site.key,
        method: request.method,
        path: request.nextUrl.pathname,
        meta: {
          filename,
          contentType,
          sizeBytes: size,
          folderId,
          meta,
          presentationFlags,
        },
      });
      return nextMediaError("upload_session_create_failed", "Failed to create upload session.", 500);
    }

    return NextResponse.json({
      token,
      plan,
      // Finalizing is always Core's: only the Server may turn a delivered body into an Asset.
      finalizeUrl: `/api/site/media/uploads/${token}/finalize`,
      // And the other end of it: a plan the Client delivers elsewhere can fail where no server sees it.
      reportUrl: `/api/site/media/uploads/${token}/report`,
      expiresAt,
      session: {
        token,
        status: PhiMediaUploadSessionStatus.Pending,
        filename,
        contentType,
        sizeBytes: size,
        kind,
        folderId,
        meta,
        presentationFlags,
      },
    });
  } catch (error) {
    await releaseMediaSpaceReservation({ spaceId: space.id, bytes: size }).catch(() => {});
    logRuntimeEvent("error", "media.upload_session.create_failed", {
      message: error instanceof Error ? error.message : "Failed to create upload session.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      error,
      meta: {
        filename,
        contentType,
        sizeBytes: size,
        folderId,
        meta,
        presentationFlags,
      },
    });
    return nextMediaError("upload_session_create_failed", "Failed to create upload session.", 500);
  }
}
