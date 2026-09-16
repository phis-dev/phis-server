import { NextResponse } from "next/server";

import type { MediaAssetRecord } from "@/db/media";
import {
  PhisMediaSpaceKind,
  resolveEffectiveMediaQuotaBytes,
  type MediaSpaceRecord,
  type PhisMediaSpaceKindValue,
  type MediaSpaceResolutionError,
  type SiteMediaConfigRecord,
} from "@/db/media-spaces";
import { PhiImageAssetVariantKey, resolvePhiMediaKindFromContentType } from "@/lib/constants/media";
import { isPhiFontSubsetKey, type PhiFontCoverage, type PhiFontMetrics, type PhiMediaSpaceKind } from "@phis/contracts/media";

type PublicMediaAssetProjection = Omit<MediaAssetRecord, "storageProfileId" | "storageKey"> & {
  deliveryUrl: string;
};

export type PhiMediaAssetTileResponse = PublicMediaAssetProjection & {
  kind: ReturnType<typeof resolvePhiMediaKindFromContentType>;
  thumbnailUrl: string | null;
};

export type PhiMediaAssetDetailResponse = PhiMediaAssetTileResponse & {
  previewUrl: string | null;
};

function isImageAsset(contentType: string) {
  return contentType.trim().toLowerCase().startsWith("image/");
}

/**
 * Where one Media Asset is served from, with the cache revision that makes it addressable.
 *
 * Exported because the Add-on assets capability hands the same path out and a second builder would be
 * a second answer: one of them would forget the revision, and a delivery that merely revalidates every
 * time looks exactly like one that works.
 */
export function resolvePhiMediaDeliveryUrl(asset: Pick<MediaAssetRecord, "id" | "deliveryRevision">) {
  return `/api/site/media/${asset.id}/content?r=${asset.deliveryRevision}`;
}

function resolveThumbnailUrl(asset: MediaAssetRecord) {
  if (!isImageAsset(asset.contentType)) {
    return null;
  }

  return (
    `/api/site/media/${asset.id}/variants/${PhiImageAssetVariantKey.Thumbnail}?r=${asset.deliveryRevision}&v=${asset.variantVersion ?? 0}`
  );
}

function resolvePreviewUrl(asset: MediaAssetRecord) {
  if (!isImageAsset(asset.contentType)) {
    return null;
  }

  return (
    `/api/site/media/${asset.id}/variants/${PhiImageAssetVariantKey.Preview}?r=${asset.deliveryRevision}&v=${asset.variantVersion ?? 0}`
  );
}

function projectPublicMediaAsset(asset: MediaAssetRecord) {
  const projection = { ...asset } as Partial<MediaAssetRecord>;
  delete projection.storageKey;
  delete projection.storageProfileId;
  return projection as Omit<MediaAssetRecord, "storageProfileId" | "storageKey">;
}

export type PhiMediaFocalRectProjection = { x: number; y: number; width: number; height: number };

function clampFocalValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : null;
}

/**
 * Projects the focal rectangle out of the opaque Asset `meta` blob.
 *
 * The rectangle is the only `meta` entry the public render path consumes, so it travels as a typed
 * field instead of shipping `meta` wholesale into a public payload.
 */
function projectFocalRect(meta: Record<string, unknown> | null): PhiMediaFocalRectProjection | null {
  const raw = meta?.focalRect;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const x = clampFocalValue(record.x);
  const y = clampFocalValue(record.y);
  const width = clampFocalValue(record.width);
  const height = clampFocalValue(record.height);
  return x == null || y == null || width == null || height == null ? null : { x, y, width, height };
}

/**
 * Projects the font metrics out of the same opaque blob.
 *
 * The second `meta` entry a public render consumes, and for the same reason as the focal rectangle: a
 * Theme building a fallback `@font-face` needs the numbers, and `meta` does not travel wholesale. Read
 * once at upload by `lib/font-metrics.ts`; nothing here re-derives them, it only refuses a shape that
 * is not what that reader writes.
 */
function projectFontMetrics(meta: Record<string, unknown> | null): PhiFontMetrics | null {
  const raw = meta?.font;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const unitsPerEm = typeof record.unitsPerEm === "number" ? record.unitsPerEm : 0;
  // Without the grid every other number is unreadable, so a projection without it is no projection.
  if (!Number.isFinite(unitsPerEm) || unitsPerEm <= 0) return null;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const nullableNumber = (value: unknown) =>
    (typeof value === "number" && Number.isFinite(value) ? value : null);
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[]) =>
    (typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null);
  return {
    format: oneOf(record.format, ["sfnt", "woff", "woff2"] as const) ?? "sfnt",
    familyName: typeof record.familyName === "string" && record.familyName.trim()
      ? record.familyName.trim()
      : null,
    unitsPerEm,
    ascent: number(record.ascent),
    descent: number(record.descent),
    lineGap: number(record.lineGap),
    capHeight: nullableNumber(record.capHeight),
    xHeight: nullableNumber(record.xHeight),
    xWidthAvg: nullableNumber(record.xWidthAvg),
    xWidthAvgSource: oneOf(record.xWidthAvgSource, ["glyphs", "os2"] as const),
    category: oneOf(record.category, ["serif", "sans-serif", "monospace"] as const),
    coverage: projectFontCoverage(record.coverage),
  };
}

/**
 * The cuts a font was recorded to have, as the site UI declares its faces from them.
 *
 * Keys outside the contract are dropped and a rest range that is not a pair of codepoints is dropped,
 * so what reaches a stylesheet is only what the upload reader could have written.
 */
function projectFontCoverage(value: unknown): PhiFontCoverage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const subsets = Array.isArray(record.subsets) ? record.subsets.filter(isPhiFontSubsetKey) : [];
  const restRanges = Array.isArray(record.restRanges)
    ? record.restRanges.filter((entry): entry is [number, number] =>
      Array.isArray(entry) && entry.length === 2
      && Number.isInteger(entry[0]) && Number.isInteger(entry[1])
      && entry[0] >= 0 && entry[0] <= entry[1] && entry[1] <= 0x10ffff)
    : [];
  return subsets.length > 0 ? { subsets, restRanges } : null;
}

/**
 * The public rendering projection for a resolved `phis:asset/<id>` reference.
 *
 * This is deliberately not the management record minus storage internals. It carries only what a
 * public page already reveals once the Asset is rendered, so a caller holding just the internal token
 * cannot learn ownership, Folder placement, audit attribution, checksums, or byte sizes. `meta` never
 * travels as a blob; its one render-relevant entry is projected as the typed `focalRect`. Lifecycle
 * and delivery policy are absent because the resolver only ever emits Site Space Assets that are Ready
 * and publicly deliverable — that guarantee lives on the server, not in a Client side filter.
 */
export type PhiPublicMediaAssetReferenceResponse = {
  id: number;
  deliveryUrl: string;
  deliveryRevision: number;
  variantVersion: number | null;
  contentType: string;
  kind: ReturnType<typeof resolvePhiMediaKindFromContentType>;
  originalName: string;
  width: number | null;
  height: number | null;
  blurDataUrl: string | null;
  title: string | null;
  altText: string | null;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  focalRect: PhiMediaFocalRectProjection | null;
  font: PhiFontMetrics | null;
};

export function serializeMediaAssetForPublicReference(
  asset: MediaAssetRecord,
): PhiPublicMediaAssetReferenceResponse {
  return {
    id: asset.id,
    deliveryUrl: resolvePhiMediaDeliveryUrl(asset),
    deliveryRevision: asset.deliveryRevision,
    variantVersion: asset.variantVersion,
    contentType: asset.contentType,
    kind: resolvePhiMediaKindFromContentType(asset.contentType),
    originalName: asset.originalName,
    width: asset.width,
    height: asset.height,
    blurDataUrl: asset.blurDataUrl,
    title: asset.title,
    altText: asset.altText,
    thumbnailUrl: resolveThumbnailUrl(asset),
    previewUrl: resolvePreviewUrl(asset),
    focalRect: projectFocalRect(asset.meta),
    font: projectFontMetrics(asset.meta),
  };
}

export function serializeMediaAssetForTile(asset: MediaAssetRecord): PhiMediaAssetTileResponse {
  return {
    ...projectPublicMediaAsset(asset),
    deliveryUrl: resolvePhiMediaDeliveryUrl(asset),
    kind: resolvePhiMediaKindFromContentType(asset.contentType),
    thumbnailUrl: resolveThumbnailUrl(asset),
  };
}

export function serializeMediaAssetForDetail(asset: MediaAssetRecord): PhiMediaAssetDetailResponse {
  return {
    ...projectPublicMediaAsset(asset),
    deliveryUrl: resolvePhiMediaDeliveryUrl(asset),
    kind: resolvePhiMediaKindFromContentType(asset.contentType),
    thumbnailUrl: resolveThumbnailUrl(asset),
    previewUrl: resolvePreviewUrl(asset),
  };
}



/**
 * Every stored kind, onto the name the wire uses.
 *
 * Typed as a total map, so a kind added to `PhisMediaSpaceKind` and forgotten here is a compile error
 * rather than a Space that quietly reports itself as another kind.
 */
const MEDIA_SPACE_KIND_NAMES: Record<PhisMediaSpaceKindValue, PhiMediaSpaceKind> = {
  [PhisMediaSpaceKind.Site]: "site",
  [PhisMediaSpaceKind.User]: "user",
  [PhisMediaSpaceKind.Group]: "group",
  [PhisMediaSpaceKind.Addon]: "addon",
};

export type PhiMediaSpaceResponse = {
  /** `null` until the Space is materialized; address it by `address` until then. */
  id: number | null;
  /** How to name this Space in a request, which a Space without a row still needs. */
  address: string;
  kind: PhiMediaSpaceKind;
  groupId: number | null;
  name: string | null;
  quotaBytes: number | null;
  usedBytes: number;
  reservedBytes: number;
};

/**
 * Projects one Space for a selector or an active-Space indicator.
 *
 * `quotaBytes` is the effective capacity after inheritance, not the raw override, so a Client never has
 * to resolve a Site default itself. The owning user id is omitted because a User Space is only ever
 * projected to its own owner; the group id remains because a Group Space needs a label.
 */
export function serializeMediaSpace(
  space: MediaSpaceRecord,
  config: SiteMediaConfigRecord,
  name?: string | null,
): PhiMediaSpaceResponse {
  const groupId = space.kind === PhisMediaSpaceKind.Group ? space.groupId : null;
  return {
    id: space.id,
    address: groupId != null ? `group:${groupId}` : String(space.id),
    kind: MEDIA_SPACE_KIND_NAMES[space.kind],
    groupId,
    name: name ?? null,
    quotaBytes: resolveEffectiveMediaQuotaBytes(space, config),
    usedBytes: space.usedBytes,
    reservedBytes: space.reservedBytes,
  };
}

/**
 * Projects a group whose Space has never been written to.
 *
 * Discovery is a Member right and must not create a row, so such a group still belongs in the selector
 * -- it just has no id to be addressed by yet, and nothing in it to account for.
 */
export function serializeUnmaterializedGroupMediaSpace(
  group: { id: number; name: string },
  config: SiteMediaConfigRecord,
): PhiMediaSpaceResponse {
  return {
    id: null,
    address: `group:${group.id}`,
    kind: "group",
    groupId: group.id,
    name: group.name,
    quotaBytes: config.defaultGroupQuotaBytes,
    usedBytes: 0,
    reservedBytes: 0,
  };
}

const MEDIA_SPACE_ERROR_STATUS: Record<MediaSpaceResolutionError, number> = {
  space_not_found: 404,
  space_forbidden: 403,
  space_kind_unavailable: 409,
  // Nothing is wrong: the Space is authorized and simply holds nothing yet.
  space_not_materialized: 404,
};

const MEDIA_SPACE_ERROR_MESSAGE: Record<MediaSpaceResolutionError, string> = {
  space_not_found: "Media Space not found.",
  space_forbidden: "Media Space not authorized for this user.",
  space_kind_unavailable: "This Media Space kind is not enabled for this Site.",
  space_not_materialized: "This Media Space holds nothing yet.",
};

/**
 * Maps a Space resolution failure to its response.
 *
 * `space_kind_unavailable` is deliberately its own status and code so an interface can tell "the Site
 * has not enabled this" apart from "not yours" and from an exhausted quota, without reading numbers.
 */
export function nextMediaSpaceError(reason: MediaSpaceResolutionError) {
  return NextResponse.json(
    { error: reason, message: MEDIA_SPACE_ERROR_MESSAGE[reason] },
    { status: MEDIA_SPACE_ERROR_STATUS[reason] },
  );
}
