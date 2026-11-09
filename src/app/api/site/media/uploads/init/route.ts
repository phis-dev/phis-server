import { after, NextRequest, NextResponse } from "next/server";

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
  resolveMediaSpaceContentKinds,
} from "@/db/media-spaces";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { nextMediaSpaceError } from "@/lib/media-response";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
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
import { phiMediaStorageProfileChecksumAlgorithm } from "@/lib/media-storage-profile-probe";
import { PHI_MEDIA_UPLOAD_SESSION_TTL_MS } from "@/lib/media-storage-policies-core";
import {
  buildPhiMediaUploadPlanChecksum,
  phiMediaUploadMayAssembleFromParts,
  readPhiMediaClientDigest,
} from "@/lib/media-upload-digest";
import { discardReleasedPhiMediaUploadStaging } from "@/lib/media-upload-staging";
import { findPhiMediaUploadToResume } from "@/lib/media-upload-resume";
import { nextMediaError } from "../_helpers";
import {
  normalizeNonNegativeInteger,
  normalizeString,
  parseStrictPositiveInt,
  readJsonObjectBody,
} from "@/lib/helpers/request";
import { readPhisMediaRequestArea } from "@/lib/media-request-area";

export const dynamic = "force-dynamic";

/** Absent flags are none; present ones are a flag word or a refused request. */
function normalizeFlags(value: unknown) {
  return value == null ? 0 : normalizeNonNegativeInteger(value);
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

/**
 * A refusal, recorded as it is issued.
 *
 * Every check ahead of the session row ends an upload before anything exists to look at afterwards:
 * no session, no asset, no reservation held. An operator asking why an upload failed would otherwise
 * find the whole class of them missing, which reads as "nothing happened" rather than "refused".
 *
 * `warn` and not `error`, because a refusal is the endpoint working: the file was too large, or not
 * what the Space is for. What is worth knowing is which rule spoke, so `reason` carries the same key
 * the caller was given, and the two can be matched.
 */
function refuseUpload(
  request: NextRequest,
  context: { siteKey: string; userId: number | null },
  refusal: { reason: string; message: string; status: number; meta?: Record<string, unknown> },
) {
  logRuntimeEvent("warn", "media.upload.refused", {
    area: readPhisMediaRequestArea(request),
    message: refusal.message,
    siteKey: context.siteKey,
    userId: context.userId,
    method: request.method,
    path: request.nextUrl.pathname,
    status: refusal.status,
    meta: { reason: refusal.reason, ...refusal.meta },
  });
  return nextMediaError(refusal.reason, refusal.message, refusal.status);
}

export async function POST(request: NextRequest) {
  const { site, session: authSession, siteWide, error } = await requireMediaSpaceWriteContext(request, async ({ site: ownSite, session }) => {
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

  // The guard's own session: reading it again here was a second statement for the same row.
  if (!authSession) {
    return refuseUpload(request, { siteKey: site.key, userId: null }, {
      reason: "authentication_required",
      message: "Authentication required.",
      status: 401,
    });
  }
  const actor = { siteKey: site.key, userId: authSession.userId };

  const payload = await readJsonObjectBody(request);
  if (!payload) {
    return nextMediaError("invalid_json_body", "Invalid JSON body.", 400);
  }

  const filename = normalizeString(payload.filename);
  const contentType = normalizeString(payload.contentType);
  const size = parseStrictPositiveInt(payload.size);
  const folderId = payload.folderId == null ? null : parseStrictPositiveInt(payload.folderId);
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
   * What the Client says it is about to send.
   *
   * Optional, and refused rather than ignored when it is malformed or the wrong shape for the declared
   * size: a digest that is quietly dropped leaves an Asset that cannot be deduplicated and nothing that
   * says why. Which shape applies follows from the size, so it is read after `size` is known.
   */
  const digestReading = readPhiMediaClientDigest({
    sizeBytes: size,
    sha256: payload.sha256,
    partSha256: payload.partSha256,
  });
  if (!digestReading.ok) {
    const message = digestReading.error === "checksum_shape"
      ? "A body of this size is described by part checksums, or by a whole-object checksum, but not both."
      : "Invalid checksum: expected lowercase hex SHA-256 digests.";
    return nextMediaError(digestReading.error, message, 400);
  }
  const clientDigest = digestReading.digest;

  /*
   * How much fits is a Site question, so it is answered before the Space is even resolved: the answer
   * is the same wherever the file was headed, and a refusal here never holds capacity it will not use.
   */
  const mediaConfig = await ensureSiteMediaConfig(site.id);
  if (!isPhiMediaObjectSizeAllowed(size, mediaConfig)) {
    return refuseUpload(request, actor, {
      reason: "media_asset_too_large",
      message: `This file is larger than the ${mediaConfig.maxObjectBytes} byte limit for this site.`,
      status: 413,
      meta: { filename, contentType, sizeBytes: size, maxObjectBytes: mediaConfig.maxObjectBytes },
    });
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
    // Its own response shape, so the reason is logged here rather than inside `refuseUpload`.
    const response = nextMediaSpaceError(resolution.reason);
    logRuntimeEvent("warn", "media.upload.refused", {
      area: readPhisMediaRequestArea(request),
      message: "Upload refused: the Media Space could not be resolved for this actor.",
      siteKey: site.key,
      userId: authSession.userId,
      method: request.method,
      path: request.nextUrl.pathname,
      status: response.status,
      meta: { reason: resolution.reason, requestedSpaceId: readRequestedMediaSpaceId(request) },
    });
    return response;
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
    return refuseUpload(request, actor, {
      reason: "content_type_not_allowed",
      message: "That kind of file does not belong in this Media Space.",
      status: 415,
      meta: {
        filename,
        declaredContentType: contentType,
        spaceId: space.id,
        spaceKind: space.kind,
        // What the Space does accept, so the refusal can be read without looking the Space up.
        accepted: resolveMediaSpaceContentKinds(space, mediaConfig),
      },
    });
  }

  const profile = await getMediaStorageProfile(site.id, space.defaultStorageProfileId);
  if (!profile) {
    return refuseUpload(request, actor, {
      reason: "storage_profile_unavailable",
      message: "Storage Profile unavailable.",
      status: 503,
      meta: { spaceId: space.id, storageProfileId: space.defaultStorageProfileId },
    });
  }
  if (folderId != null && !await getMediaFolderBySiteAndId(site.id, space.id, folderId)) {
    return refuseUpload(request, actor, {
      reason: "folder_not_found",
      message: "Folder not found in the active Media Space.",
      status: 404,
      meta: { folderId, spaceId: space.id },
    });
  }
  /*
   * Maintenance happens at the moment the resource is requested: whoever asks this Space for capacity
   * first hands back the capacity its own expired sessions are still holding.
   *
   * What they left at the Provider comes back with them, because deleting the row is what frees the
   * reservation and the row is also the only record of where the remains are. Removing them happens after
   * the response -- this request is waiting for a plan, not for a storage to answer about objects that are
   * no longer anybody's.
   */
  const released = await releaseExpiredMediaUploadSessions(space.id);
  const storageService = await createPhisMediaStorageServiceForProfile(profile, site.key)
  const kind = resolvePhiMediaUploadSessionKind(contentType);
  /*
   * The expired sessions' remains, cleaned up once this response is out.
   *
   * Registered here rather than further down so that it covers every way out of this handler below --
   * including the upload that is carried on rather than opened, which reserves nothing and would otherwise
   * be the one path where a sweep found remains and nobody removed them.
   *
   * After the response, because a storage call has no business delaying the plan this request came for. And
   * at all, because the rows are already gone: what is not removed now is reachable only through the
   * Provider's own lifecycle rule. Sessions naming another Profile are left to exactly that -- their objects
   * are in another storage, and opening it would mean reading a secret on behalf of an upload that has
   * nothing to do with it.
   */
  if (released.length > 0) {
    after(async () => {
      const outcome = await discardReleasedPhiMediaUploadStaging({
        siteKey: site.key,
        storageProfileId: profile.id,
        profile,
        sessions: released,
      });
      logRuntimeEvent(outcome.failed > 0 ? "warn" : "info", "media.upload.expired_staging_discarded", {
        message:
          `Removed ${outcome.discarded} of ${released.length} expired staging object(s) in Space ${space.id}.`,
        siteKey: site.key,
        meta: {
          spaceId: space.id,
          released: released.length,
          discarded: outcome.discarded,
          // On another Profile, so another storage's lifecycle rule is what reaches them.
          skipped: outcome.skipped,
          failed: outcome.failed,
        },
      });
    });
  }
  /*
   * Whether this Profile may answer with an object assembled from parts: Core's decision, from the size
   * alone. Above one part a resumable upload is worth having, and nothing is traded away for it -- an
   * assembled object carries `sha256-composite`, which duplicate detection compares.
   */
  const mayAssembleFromParts = phiMediaUploadMayAssembleFromParts(size);
  /*
   * The digest the Client claims, turned into something Core may assert.
   *
   * Only under a Profile whose endpoint was measured to verify SHA-256, because that verification is the
   * whole basis for recording a number Core never computed: the digest is signed into the upload request
   * and a body that does not match it is refused at the endpoint. Under any other Profile the claim is
   * dropped and the body's digest is whatever its path can establish.
   */
  const profileChecksumAlgorithm = await phiMediaStorageProfileChecksumAlgorithm(profile, site.key);
  const planChecksum = buildPhiMediaUploadPlanChecksum(clientDigest, profileChecksumAlgorithm);

  /*
   * An upload of this very file that a page stopped delivering, carried on instead of paid for twice.
   *
   * Here, ahead of the reservation, because the session being taken over is still holding one: its parts
   * are at the Provider and the Space is already charged for them. Reserving again would charge it twice
   * for one body, and a Space near its limit would refuse the retry of an upload it is itself holding the
   * capacity for.
   *
   * Which file it is comes from the digest and from nothing weaker -- see `media-upload-resume.ts`. Only a
   * body above one part can be continued at all, which is the same condition that allows the plan.
   */
  const resumed = mayAssembleFromParts
    ? await findPhiMediaUploadToResume({
        siteId: site.id,
        siteKey: site.key,
        spaceId: space.id,
        actorUserId: authSession.userId,
        filename,
        sizeBytes: size,
        storageProfileId: profile.id,
        checksum: planChecksum.checksum ?? null,
        // The same digests a fresh plan would sign, so the parts still missing are signed as they were.
        partChecksums: planChecksum.partChecksums ?? [],
        storage: storageService,
        folderId,
        presentationFlags: presentationFlags ?? 0,
        meta: meta ?? null,
      })
    : null;
  if (resumed) {
    logRuntimeEvent("info", "media.upload.resumed", {
      area: readPhisMediaRequestArea(request),
      message:
        `Upload session ${resumed.token} was taken over with ${resumed.uploaded.length} part(s) already stored.`,
      siteKey: site.key,
      userId: authSession.userId,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        spaceId: space.id,
        storageProfileId: profile.id,
        originalName: filename,
        sizeBytes: size,
        stored: resumed.uploaded.length,
        remaining: resumed.remainingParts,
      },
    });
    return NextResponse.json({
      token: resumed.token,
      plan: resumed.plan,
      /*
       * The parts the storage already holds, with the tags a completion has to name.
       *
       * They travel beside the plan rather than inside it because they are not addresses to deliver to:
       * nobody is to send those parts again. The Client names them at finalize together with the ones it
       * sends now, and it is the only place they could come from -- the page that put them there is gone.
       */
      uploaded: resumed.uploaded,
      /** So a Client can tell a continued upload from a fresh one, in its own reporting and its progress. */
      resumed: true,
      finalizeUrl: `/api/site/media/uploads/${resumed.token}/finalize`,
      reportUrl: `/api/site/media/uploads/${resumed.token}/report`,
      expiresAt: resumed.expiresAt,
      session: {
        token: resumed.token,
        status: resumed.status,
        filename,
        contentType,
        sizeBytes: size,
        kind,
        folderId,
        meta,
        presentationFlags,
      },
    });
  }

  if (!await reserveMediaSpaceQuota({ spaceId: space.id, bytes: size })) {
    return refuseUpload(request, actor, {
      reason: "media_quota_exceeded",
      message: "Media Space quota exceeded.",
      status: 413,
      meta: { spaceId: space.id, spaceKind: space.kind, requestedBytes: size },
    });
  }
  const token = createPhiMediaUploadSessionToken();
  const tempStorageKey = storageService.createUploadTempStorageKey({
    siteKey: site.key,
    token,
    originalName: filename,
  });
  const finalStorageKey = storageService.createStorageKey({
    siteKey: site.key,
  });
  const expiresAt = new Date(Date.now() + PHI_MEDIA_UPLOAD_SESSION_TTL_MS).toISOString();
  // How the body is to be delivered is the Provider's to state, not the Client's to assume. Core owns
  // its own route table, so the address it would receive a body at is handed over rather than guessed.
  const plan = await storageService.createUploadPlan({
    token,
    storageKey: tempStorageKey,
    contentType,
    sizeBytes: size,
    expiresAt,
    proxyUploadUrl: `/api/site/media/uploads/${token}`,
    ...(mayAssembleFromParts ? { mayAssembleFromParts: true } : {}),
    ...planChecksum,
  });
  const uploadPlanKind = resolvePhiMediaUploadPlanKind(plan.kind);

  /*
   * Recorded on the session only where the plan actually carries it into the request.
   *
   * A proxied body is hashed by Core as it streams, and that figure is the better one: measured here
   * rather than asserted anywhere. Writing the claim onto the session as well would mean finalize
   * preferring the claim over the measurement, which is the wrong way round.
   */
  const sessionChecksum = planChecksum.checksum && plan.kind !== "proxy-stream"
    ? { checksumAlgorithm: planChecksum.checksum.algorithm, checksumValue: planChecksum.checksum.value }
    : {};
  /*
   * An assembly has a name at the Provider, and only the session can keep it.
   *
   * Without it an abandoned multipart upload cannot be aborted: the parts are billed, they do not appear
   * in a listing, and the Client that could have named the upload is the thing that went away. The schema
   * requires it for exactly this plan kind and forbids it for the others.
   */
  const providerUpload = plan.kind === "multipart-put" ? { providerUploadId: plan.uploadId } : {};

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
      ...sessionChecksum,
      ...providerUpload,
    });

    if (!uploadSession) {
      // The reservation was taken before the session row; without the row nothing can release it later.
      await releaseMediaSpaceReservation({ spaceId: space.id, bytes: size });
      logRuntimeEvent("error", "media.upload_session.create_failed", {
        area: readPhisMediaRequestArea(request),
        message: "Failed to create upload session: the insert returned no row.",
        siteKey: site.key,
        userId: authSession.userId,
        method: request.method,
        path: request.nextUrl.pathname,
        status: 500,
        meta: {
          spaceId: space.id,
          storageProfileId: profile.id,
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
    /*
     * A refusal by the database, which is not a refusal of the upload.
     *
     * Everything the caller was told is that this failed; what actually happened is a constraint or a
     * connection, and only this record carries it. So the message names the step -- an operator reading
     * a list of events should not have to recognise Postgres wording to see which one broke -- while
     * the driver's own text, code and constraint name travel in `error`, where the detail view shows
     * them. `normalizeLogThrowable` because a raw throwable is not reliably serializable.
     */
    logRuntimeEvent("error", "media.upload_session.create_failed", {
      area: readPhisMediaRequestArea(request),
      message: "Failed to create upload session: the database refused the row.",
      siteKey: site.key,
      userId: authSession.userId,
      method: request.method,
      path: request.nextUrl.pathname,
      status: 500,
      error: normalizeLogThrowable(error),
      meta: {
        spaceId: space.id,
        storageProfileId: profile.id,
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
