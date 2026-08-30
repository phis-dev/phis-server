import "server-only";

import type { NextRequest } from "next/server";

import type { MediaAssetRecord } from "@/db/media";
import { getMediaSpaceById, isEffectiveMediaGroupMember, PhiMediaDeliveryPolicy, PhiMediaLifecycleStatus, PhiMediaSpaceKind } from "@/db/media-spaces";
import { getSessionFromRequest } from "@/db/user-sessions";
import { getApiV1TokenMode } from "@/lib/api-v1-guard";

export async function canDeliverMediaAsset(request: NextRequest, asset: MediaAssetRecord) {
  if (asset.lifecycleStatus !== PhiMediaLifecycleStatus.Ready) return false;
  const tokenMode = getApiV1TokenMode(request);
  if (asset.deliveryPolicy === PhiMediaDeliveryPolicy.Internal) return tokenMode === "internal";
  if (asset.deliveryPolicy === PhiMediaDeliveryPolicy.Public) return true;
  const session = await getSessionFromRequest(request, asset.siteId);
  if (!session) return false;
  if (asset.deliveryPolicy === PhiMediaDeliveryPolicy.Authenticated) return true;
  const space = await getMediaSpaceById(asset.siteId, asset.spaceId);
  if (!space) return false;
  if (asset.deliveryPolicy === PhiMediaDeliveryPolicy.User) {
    return space.kind === PhiMediaSpaceKind.User && space.userId === session.userId;
  }
  return asset.deliveryPolicy === PhiMediaDeliveryPolicy.Group &&
    space.kind === PhiMediaSpaceKind.Group && space.groupId != null &&
    await isEffectiveMediaGroupMember(asset.siteId, space.groupId, session.userId);
}

export function mediaDeliveryCacheControl(request: NextRequest, asset: MediaAssetRecord) {
  if (asset.deliveryPolicy !== PhiMediaDeliveryPolicy.Public) {
    return "private, no-store";
  }

  const requestedRevision = Number.parseInt(request.nextUrl.searchParams.get("r") ?? "", 10);
  return requestedRevision === asset.deliveryRevision
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";
}

/*
 * What a browser may be allowed to render in place.
 *
 * A closed list owned by the code, deliberately not a Site setting: the question is not what a Site
 * wants to permit but what a browser does with the bytes, and that answer does not vary per Site. An
 * operator can therefore not set it wrongly, and a type nobody thought about is safe because it is
 * absent rather than because someone remembered to exclude it.
 *
 * The notable absences are absences on purpose. `image/svg+xml` is a document when it is navigated to
 * and runs script in the Site's own origin; as an attachment it still renders through `<img>`, which
 * loads SVG in image mode with scripting disabled, so nothing that displays a logo is affected.
 * `application/pdf` carries its own scripting engine. `text/html` needs no explanation.
 */
const PHI_MEDIA_INLINE_SAFE_CONTENT_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "image/bmp", "image/x-icon", "image/vnd.microsoft.icon",
  "audio/aac", "audio/flac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm",
  "video/mp4", "video/ogg", "video/webm",
]);

/*
 * RFC 6266: an ASCII fallback for readers that predate the encoded form, and the encoded form for the
 * rest. `encodeURIComponent` leaves ' ( ) * intact and RFC 5987's attr-char does not permit them.
 */
function mediaDeliveryFilename(downloadName: string) {
  const ascii = downloadName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").trim() || "download";
  const encoded = encodeURIComponent(downloadName)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Makes a delivered object harmless regardless of what it turned out to be.
 *
 * Content sniffing at upload is a floor rather than a roof -- SVG and HTML are text without magic
 * bytes, and polyglot files exist -- and the Site Space accepts anything on purpose, because what a
 * Site publishes includes binaries offered for download. The response is therefore where an active
 * file stops being dangerous: anything not provably inline-safe is handed over as a download, `nosniff`
 * stops a browser from improving on the declared type, and the sandbox denies the opaque origin a
 * document gets everything it would need to matter if the list above is ever wrong.
 */
export function mediaDeliverySafetyHeaders(contentType: string, downloadName: string) {
  const normalized = contentType.trim().toLowerCase().split(";", 1)[0]!.trim();
  const disposition = PHI_MEDIA_INLINE_SAFE_CONTENT_TYPES.has(normalized) ? "inline" : "attachment";
  return {
    "content-disposition": `${disposition}; ${mediaDeliveryFilename(downloadName)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
  };
}
