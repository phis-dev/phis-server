import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";

import {
  abortMediaUploadSessionByToken,
  claimMediaUploadSessionForFinalize,
  createMediaAssetFromUploadSession,
  getMediaAssetBySiteAndChecksum,
  getMediaUploadSessionByToken,
} from "@/db/media";
import {
  ensureSiteMediaConfig,
  getMediaSpaceById,
  getMediaStorageProfile,
  isPhiMediaContentAllowedInSpace,
  PhiMediaLifecycleStatus,
} from "@/db/media-spaces";
import { getSessionFromRequest } from "@/db/user-sessions";
import { clearSiteConfigCache } from "@/db/site-config";
import {
  PHI_MEDIA_SNIFF_HEAD_BYTES,
  resolvePhiMediaStoredContentType,
  sniffPhiMediaContentType,
} from "@/lib/media-content-sniffer";
import { PhiMediaKind, resolvePhiMediaKindFromContentType } from "@/lib/constants/media";
import { readPhiFontMetrics } from "@/lib/font-metrics";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { PHIS_CMS_AREA_KEYS } from "@/lib/constants/cms-areas";
import {
  isPhiMediaUploadBodyProxied,
  PhiMediaUploadSessionStatus,
} from "@/lib/media-upload-sessions";
import { serializeMediaAssetForDetail } from "@/lib/media-response";
import { requireMediaSpaceWriteContext } from "@/lib/guards/site-media-api";
import { nextMediaError } from "../../_helpers";
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


const SVG_MIN_DISPLAY_DIMENSION = 48;

/*
 * How much of an object `finalize` is willing to hold at once, stated rather than implied.
 *
 * It used to hold all of it, three times over: the SVG scan, the image decode, and a re-upload of the
 * whole body onto the final key. For a Provider that stores remotely that is a download plus an upload
 * of every byte -- impossible for a multipart object. The settle is a copy now, and these two are what
 * remains, each bounded on purpose.
 *
 * The SVG limit is a refusal, not a truncation. The scan looks for a script element anywhere in the
 * document, so reading a prefix would let one past by putting it late: an SVG too large to check is
 * not accepted rather than half-checked.
 *
 * The image limit is a skip. Dimensions and the blur placeholder are conveniences; an Asset without
 * them is complete, so past the ceiling they are simply absent rather than worth a decode of that size.
 */
const PHI_SVG_SCAN_LIMIT_BYTES = 2 * 1024 * 1024;
const PHI_IMAGE_DECODE_LIMIT_BYTES = 64 * 1024 * 1024;
/*
 * A whole font in hand, which is what reading its tables needs -- a woff2 keeps them behind one Brotli
 * stream, so there is no prefix that answers. Generous for a format where a full family is well under a
 * megabyte, and a ceiling all the same.
 */
const PHI_FONT_READ_LIMIT_BYTES = 16 * 1024 * 1024;

function isSvgContentType(contentType: string) {
  return contentType.trim().toLowerCase().split(";", 1)[0] === "image/svg+xml";
}

function normalizeSvgMetadataDimensions(width: number | null, height: number | null) {
  if (!width || !height) {
    return {
      width: SVG_MIN_DISPLAY_DIMENSION,
      height: SVG_MIN_DISPLAY_DIMENSION,
    };
  }

  const shortestSide = Math.min(width, height);
  if (shortestSide >= SVG_MIN_DISPLAY_DIMENSION) {
    return { width, height };
  }

  const scale = SVG_MIN_DISPLAY_DIMENSION / shortestSide;
  return {
    width: Math.max(SVG_MIN_DISPLAY_DIMENSION, Math.round(width * scale)),
    height: Math.max(SVG_MIN_DISPLAY_DIMENSION, Math.round(height * scale)),
  };
}

async function readImageMetadata(body: Buffer, contentType: string) {
  if (!contentType.trim().toLowerCase().startsWith("image/")) {
    return {
      width: null as number | null,
      height: null as number | null,
      blurDataUrl: null as string | null,
    };
  }

  try {
    const image = sharp(body, { failOn: "none" }).rotate();
    const metadata = await image.metadata();
    const rawWidth = metadata.width ?? null;
    const rawHeight = metadata.height ?? null;
    const { width, height } = isSvgContentType(contentType)
      ? normalizeSvgMetadataDimensions(rawWidth, rawHeight)
      : { width: rawWidth, height: rawHeight };

    let blurDataUrl: string | null = null;
    if (rawWidth && rawHeight) {
      const blurBuffer = await image
        .clone()
        .resize(16, 16, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 60 })
        .toBuffer();
      blurDataUrl = `data:image/webp;base64,${blurBuffer.toString("base64")}`;
    }

    return {
      width,
      height,
      blurDataUrl,
    };
  } catch {
    return {
      width: null as number | null,
      height: null as number | null,
      blurDataUrl: null as string | null,
    };
  }
}

function validateSvgUpload(body: Buffer, contentType: string) {
  if (contentType.trim().toLowerCase() !== "image/svg+xml") {
    return null;
  }

  const source = body.toString("utf8");
  const normalized = source.toLowerCase();
  if (!normalized.includes("<svg")) {
    return "SVG upload does not contain an SVG root.";
  }
  if (/<script[\s>]/i.test(source)) {
    return "SVG uploads must not contain script elements.";
  }
  if (/<foreignobject[\s>]/i.test(source)) {
    return "SVG uploads must not contain foreignObject elements.";
  }
  if (/\son[a-z]+\s*=/i.test(source)) {
    return "SVG uploads must not contain event handler attributes.";
  }
  if (/\s(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:|javascript:)/i.test(source)) {
    return "SVG uploads must not contain external or executable references.";
  }

  return null;
}

/**
 * The completion report the plan's issuer asked the Client to bring back.
 *
 * Read as one opaque value and handed to the Provider unchanged: Core validating another Provider's
 * report would be Core knowing that Provider. An absent body is the ordinary case -- a plan that
 * delivered its body in one request has nothing to report.
 */
function readUploadCompletion(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return (body as { completion?: unknown }).completion;
}

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
    // The staged session is the destination. Reading it here rather than trusting a query parameter
    // means the authority is decided by where the bytes will actually land.
    const staged = await getMediaUploadSessionByToken(token);
    return staged?.spaceId ?? null;
  });
  if (error) {
    return error;
  }

  const body = await request.json().catch(() => null);

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

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await abortMediaUploadSessionByToken(token);
    return nextMediaError("upload_session_expired", "Upload session expired.", 410);
  }

  // Only the plan that streams through Core lets Core record that the body arrived. On any other plan
  // the stored object is the sole evidence, which `completeUpload` below is what asks for.
  if (
    isPhiMediaUploadBodyProxied(session.uploadPlanKind) &&
    session.status !== PhiMediaUploadSessionStatus.Uploaded
  ) {
    return nextMediaError("upload_body_missing", "Upload body missing.", 409);
  }

  const profile = await getMediaStorageProfile(site.id, session.storageProfileId);
  if (!profile) return nextMediaError("storage_profile_unavailable", "Storage Profile is unavailable.", 503);
  const storageService = await createPhisMediaStorageServiceForProfile(profile, site.key)

  // Settle the staged object first: a Provider that had the Client deliver its body in pieces assembles
  // it here, and one that took it whole simply looks. What the Client brought back travels through
  // unread -- Core has no business interpreting another Provider's completion report.
  const staged = await storageService.completeUpload({
    storageKey: session.stagingStorageKey,
    completion: readUploadCompletion(body),
  }).catch(() => null);
  if (!staged) {
    await abortMediaUploadSessionByToken(token);
    return nextMediaError("temporary_upload_not_found", "Temporary upload not found.", 404);
  }
  if (staged.byteSize !== session.sizeBytes) {
    await storageService.deleteObject(session.stagingStorageKey).catch(() => {});
    await abortMediaUploadSessionByToken(token);
    return nextMediaError("upload_size_mismatch", "Upload size mismatch.", 400);
  }

  /*
   * What the object turned out to be, which is the first point in the whole flow where anyone knows.
   *
   * `uploads/init` could only weigh the declared type, and the declaration is written by the one party
   * a content rule exists for. Here the bytes answer instead -- the first few kilobytes of them, so
   * identifying a four gigabyte video costs the same as identifying a thumbnail, and a Provider that
   * stores remotely reads a range rather than the body.
   *
   * A mismatch is not itself a refusal. Browsers label inconsistently and honest files arrive
   * mislabelled all the time, so the stored type simply becomes the true one. What is refused is the
   * Space rule applied again to what actually arrived: not "you said something else" but "this does
   * not belong here", which is the only part a person can act on.
   */
  const head = await storageService.readObjectHead(session.stagingStorageKey, PHI_MEDIA_SNIFF_HEAD_BYTES);
  const sniffed = sniffPhiMediaContentType(head ?? Buffer.alloc(0), session.contentType);
  const contentType = resolvePhiMediaStoredContentType(sniffed);
  const targetSpace = await getMediaSpaceById(site.id, session.spaceId);
  const mediaConfig = await ensureSiteMediaConfig(site.id);
  if (targetSpace && !isPhiMediaContentAllowedInSpace(contentType, targetSpace, mediaConfig)) {
    await storageService.deleteObject(session.stagingStorageKey).catch(() => {});
    await abortMediaUploadSessionByToken(token);
    logRuntimeEvent("warn", "media.upload.content_refused", {
      area: resolveRequestArea(request),
      userId: authSession.userId,
      message: "Upload refused: the object is not what this Media Space accepts.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        originalName: session.filename,
        declaredContentType: session.contentType,
        contentType,
        evidence: sniffed.evidence,
        sizeBytes: session.sizeBytes,
      },
    });
    return nextMediaError(
      "content_type_not_allowed",
      "That kind of file does not belong in this Media Space.",
      415,
    );
  }

  /*
   * What the object is decides whether it is a duplicate, so every plan is judged here rather than at
   * the transport that happened to carry it.
   *
   * The session's own digest comes first: on a proxied body Core hashed it in flight, and on a
   * presigned one the endpoint refused anything that did not match what the client stated. Failing
   * both, whatever the Provider can attest about the stored object -- and where it can attest nothing,
   * nothing is recorded. `getMediaAssetBySiteAndChecksum` then decides whether the digest is one that
   * can answer "is this the same file" at all; a CRC or an MD5 is kept as evidence of an intact
   * transfer without being compared.
   */
  const stagedChecksum = session.checksumAlgorithm && session.checksumValue
    ? { algorithm: session.checksumAlgorithm, value: session.checksumValue }
    : staged.checksum ?? null;

  /*
   * Where both sides have an opinion, they have to agree.
   *
   * The session's digest was signed into the upload and the Provider's was read off the stored object, so
   * two different answers mean one of them is not about these bytes -- a Provider that ignored the digest
   * it was handed, an object written by something else at the same key, or an assembly divided differently
   * than Core believes. Recording either would put a wrong figure in the column duplicate detection
   * compares, and a wrong figure there refuses somebody else's upload later.
   */
  if (
    session.checksumAlgorithm && session.checksumValue && staged.checksum &&
    (staged.checksum.algorithm !== session.checksumAlgorithm || staged.checksum.value !== session.checksumValue)
  ) {
    await abortMediaUploadSessionByToken(token);
    logRuntimeEvent("error", "media.upload.checksum_mismatch", {
      area: resolveRequestArea(request),
      userId: authSession.userId,
      message: "The stored object's digest is not the one the upload was signed for.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        signed: `${session.checksumAlgorithm}:${session.checksumValue}`,
        stored: `${staged.checksum.algorithm}:${staged.checksum.value}`,
        sizeBytes: session.sizeBytes,
      },
    });
    return nextMediaError(
      "checksum_mismatch",
      "The stored object does not carry the checksum this upload was signed for.",
      409,
    );
  }

  if (stagedChecksum) {
    const existingAsset = await getMediaAssetBySiteAndChecksum(site.id, session.spaceId, stagedChecksum);
    if (existingAsset) {
      await storageService.deleteObject(session.stagingStorageKey).catch(() => {});
      await abortMediaUploadSessionByToken(token);
      logRuntimeEvent("warn", "media.upload.duplicate", {
        area: resolveRequestArea(request),
        userId: authSession.userId,
        message: "Duplicate media asset upload rejected.",
        siteKey: site.key,
        method: request.method,
        path: request.nextUrl.pathname,
        meta: {
          originalName: session.filename,
          contentType: session.contentType,
          sizeBytes: session.sizeBytes,
          checksum: `${stagedChecksum.algorithm}:${stagedChecksum.value}`,
        },
      });
      return NextResponse.json(
        {
          error: "media_asset_exists",
          message: "This asset already exists.",
          asset: serializeMediaAssetForDetail(existingAsset),
        },
        { status: 409 },
      );
    }
  }

  /*
   * The one read that still needs more than a prefix, and only for the kind that cannot be checked
   * without it. Everything else below works from the head or from the Provider's own metadata.
   */
  let scannedBody: Buffer | null = null;
  if (isSvgContentType(contentType)) {
    if (staged.byteSize > PHI_SVG_SCAN_LIMIT_BYTES) {
      await storageService.deleteObject(session.stagingStorageKey).catch(() => {});
      await abortMediaUploadSessionByToken(token);
      return nextMediaError(
        "unsafe_svg_upload",
        `An SVG larger than ${PHI_SVG_SCAN_LIMIT_BYTES} bytes cannot be checked and is not accepted.`,
        413,
      );
    }
    scannedBody = await storageService.readObjectHead(session.stagingStorageKey, staged.byteSize);
  }
  if (isSvgContentType(contentType) && !scannedBody) {
    await abortMediaUploadSessionByToken(token);
    return nextMediaError("temporary_upload_not_found", "Temporary upload not found.", 404);
  }

  const svgValidationError = scannedBody ? validateSvgUpload(scannedBody, contentType) : null;
  if (svgValidationError) {
    await storageService.deleteObject(session.stagingStorageKey).catch(() => {});
    await abortMediaUploadSessionByToken(token);
    logRuntimeEvent("warn", "media.upload.svg_rejected", {
      area: resolveRequestArea(request),
      userId: authSession.userId,
      message: svgValidationError,
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        originalName: session.filename,
        contentType: session.contentType,
        sizeBytes: session.sizeBytes,
      },
    });
    return nextMediaError("unsafe_svg_upload", svgValidationError, 400);
  }

  /*
   * A decode, and therefore the only place a whole object is still held -- bounded, and only for the
   * kind that has anything to decode. An SVG is already in hand from the scan above.
   */
  const shouldDecode = contentType.trim().toLowerCase().startsWith("image/")
    && staged.byteSize <= PHI_IMAGE_DECODE_LIMIT_BYTES;
  const decodableBody = scannedBody ?? (shouldDecode ? await storageService.getObject(session.stagingStorageKey) : null);
  const imageMeta = decodableBody
    ? await readImageMetadata(decodableBody, contentType)
    : { width: null, height: null, blurDataUrl: null };

  /*
   * A typeface states its own proportions, and this is the only moment anyone will read them.
   *
   * A font delivered from the Media library has no fallback face, so the browser sets the page in a
   * substitute and reflows when the real file lands. The `size-adjust` and `*-override` descriptors
   * that prevent it are arithmetic on numbers inside the file, and a render must not be opening font
   * files to find them. So they are read here, once, and travel with the Asset.
   *
   * A font that cannot be read is still stored. It simply arrives without metrics, and a Theme that
   * uses it falls back to an unadjusted face -- which is exactly where everything stood before.
   */
  const fontBody = resolvePhiMediaKindFromContentType(contentType) === PhiMediaKind.Font
    && staged.byteSize <= PHI_FONT_READ_LIMIT_BYTES
    ? await storageService.getObject(session.stagingStorageKey)
    : null;
  const fontMetrics = fontBody ? readPhiFontMetrics(fontBody) : null;
  const assetMeta = fontMetrics ? { ...(session.meta ?? {}), font: fontMetrics } : session.meta ?? null;

  // From here on a failure deletes the objects, so only one request per session may get here. A second
  // finalize for the same token is told so and touches nothing -- its cleanup is what used to delete the
  // bytes the first one's Asset points at.
  const claimed = await claimMediaUploadSessionForFinalize(
    token,
    isPhiMediaUploadBodyProxied(session.uploadPlanKind) ? PhiMediaUploadSessionStatus.Uploaded : null,
  );
  if (!claimed) {
    return nextMediaError(
      "upload_session_finalizing",
      "Upload session is already being finalized.",
      409,
    );
  }

  try {
    const targetStorageKey = session.finalStorageKey ?? session.stagingStorageKey;
    const finalObject = await storageService.copyObject({
      sourceKey: session.stagingStorageKey,
      targetKey: targetStorageKey,
      // The measured type, not the claimed one: what a Provider stores is what delivery hands back.
      contentType,
      metadata: {
        token: session.token,
        siteKey: site.key,
        filename: session.filename,
      },
    });
    if (!finalObject) {
      throw new Error("Failed to settle the staged object onto its final key.");
    }

    // The settle may have copied the object onto its final key, so the Provider is asked again rather
    // than assumed to answer the same -- but what the staged object established outranks it, because
    // that is the digest something actually verified.
    const checksum = stagedChecksum ?? finalObject.checksum ?? null;

    // The Space decides what the Asset is visible to until a Module widens it for a purpose. The row
    // and the committed reservation land in one transaction: exactly what was reserved moves to used
    // and the session closes with it. The PUT step already enforces that the stored object matches the
    // declared size, so declared and actual are equal today.
    const asset = await createMediaAssetFromUploadSession(token, {
      siteId: site.id,
      spaceId: session.spaceId,
      spaceKind: targetSpace?.kind ?? null,
      folderId: session.folderId,
      createdByUserId: session.actorUserId,
      updatedByUserId: session.actorUserId,
      storageProfileId: session.storageProfileId,
      storageKey: finalObject.storageKey,
      originalName: session.filename,
      contentType,
      bytes: finalObject.byteSize,
      checksumAlgorithm: checksum?.algorithm ?? null,
      checksumValue: checksum?.value ?? null,
      width: imageMeta.width,
      height: imageMeta.height,
      blurDataUrl: imageMeta.blurDataUrl,
      meta: assetMeta,
      title: null,
      altText: null,
      lifecycleStatus: PhiMediaLifecycleStatus.Ready,
      // No explicit policy: the Space decides, and only a Module widens it for a purpose.
      presentationFlags: session.presentationFlags,
    });
    // Only when it is a different object: a plan that staged straight onto its final key has nothing
    // left over, and deleting the staging key there would delete the Asset.
    if (targetStorageKey !== session.stagingStorageKey) {
      await storageService.deleteObject(session.stagingStorageKey).catch(() => {});
    }
    clearSiteConfigCache(site.id);

    return NextResponse.json({
      asset: serializeMediaAssetForDetail(asset),
    });
  } catch (finalizeError) {
    logRuntimeEvent("error", "media.upload.finalize_failed", {
      area: resolveRequestArea(request),
      userId: authSession.userId,
      message: finalizeError instanceof Error ? finalizeError.message : "Finalize failed.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      error: normalizeLogThrowable(finalizeError),
      meta: {
        originalName: session.filename,
        contentType: session.contentType,
        sizeBytes: session.sizeBytes,
        storageKey: session.finalStorageKey ?? session.stagingStorageKey,
      },
    });

    await storageService.deleteObject(session.stagingStorageKey).catch(() => {});
    if (session.finalStorageKey) {
      await storageService.deleteObject(session.finalStorageKey).catch(() => {});
    }
    await abortMediaUploadSessionByToken(token);
    return NextResponse.json(
      {
        error: "finalize_failed",
        message: finalizeError instanceof Error ? finalizeError.message : "Finalize failed.",
      },
      { status: 500 },
    );
  }
}
