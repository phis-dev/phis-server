import "server-only";

import type { NextRequest } from "next/server";

import type { MediaAssetRecord } from "@/db/media";
import { getMediaSpaceById, isEffectiveMediaGroupMember, PhiMediaDeliveryPolicy, PhiMediaLifecycleStatus, PhisMediaSpaceKind } from "@/db/media-spaces";
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
    return space.kind === PhisMediaSpaceKind.User && space.userId === session.userId;
  }
  return asset.deliveryPolicy === PhiMediaDeliveryPolicy.Group &&
    space.kind === PhisMediaSpaceKind.Group && space.groupId != null &&
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

/**
 * Which bytes a request asked for, or why it gets the whole object instead.
 *
 * `full` is the answer to anything this does not have to honour, and RFC 9110 permits that: no header, a
 * unit other than `bytes`, syntax that does not parse, or more than one range. Several ranges would mean a
 * multipart body, which nothing that plays media asks for and which would be a second response format to
 * get right for no one's benefit -- so a request for two ranges is served completely, which is always
 * correct if never clever.
 *
 * `unsatisfiable` is the one case that must not become `full`: a first byte at or past the end of the
 * object is a `416`, because answering it with the whole file tells a player its seek succeeded.
 *
 * A suffix range longer than the object, and a last byte past the end, are both clamped rather than
 * refused. That is what the specification asks for, and a player that asks for "the last megabyte" of a
 * smaller file means the file.
 */
export type PhiMediaRangeRequest =
  | { kind: "full" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; offset: number; length: number };

export function parsePhiMediaRangeRequest(
  header: string | null | undefined,
  byteSize: number,
): PhiMediaRangeRequest {
  const value = header?.trim();
  if (!value) return { kind: "full" };

  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match) return { kind: "full" };

  const [, rawFirst, rawLast] = match;
  if (!rawFirst && !rawLast) return { kind: "full" };

  // An empty object has no byte to serve, so every range over it is unsatisfiable.
  if (byteSize <= 0) return { kind: "unsatisfiable" };

  if (!rawFirst) {
    const suffix = Number(rawLast);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "unsatisfiable" };
    const offset = Math.max(0, byteSize - suffix);
    return { kind: "range", offset, length: byteSize - offset };
  }

  const first = Number(rawFirst);
  if (!Number.isSafeInteger(first) || first < 0) return { kind: "full" };
  if (first >= byteSize) return { kind: "unsatisfiable" };

  if (!rawLast) return { kind: "range", offset: first, length: byteSize - first };

  const last = Number(rawLast);
  if (!Number.isSafeInteger(last) || last < first) return { kind: "full" };
  return { kind: "range", offset: first, length: Math.min(last, byteSize - 1) - first + 1 };
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
