import "server-only";

import {
  deleteImageAssetVariantsByAssetId,
  getMediaAssetBySiteAndId,
  getMediaFolderBySiteAndId,
  hasLockedMediaFolder,
  normalizeMediaFocalRect,
  type MediaAssetRecord,
  updateMediaAsset,
} from "@/db/media";
import { clearSiteConfigCache } from "@/db/site-config";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";

export class MediaAssetUpdateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MediaAssetUpdateError";
  }
}

function nullableString(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function nullableInt(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function flagsValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizedMeta(value: unknown) {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  const meta = { ...(value as Record<string, unknown>) };
  if (Object.hasOwn(meta, "focalRect")) {
    const focalRect = meta.focalRect == null ? null : normalizeMediaFocalRect(meta.focalRect);
    if (meta.focalRect != null && !focalRect) return null;
    if (focalRect) meta.focalRect = focalRect;
    else delete meta.focalRect;
  }
  return meta;
}

function focalRect(value: Record<string, unknown> | null | undefined) {
  return value && Object.hasOwn(value, "focalRect") && value.focalRect != null
    ? normalizeMediaFocalRect(value.focalRect)
    : null;
}

function equalFocalRects(
  left: ReturnType<typeof focalRect>,
  right: ReturnType<typeof focalRect>,
) {
  return (
    left === right ||
    Boolean(
      left &&
      right &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height,
    )
  );
}

type MediaAssetUpdateInput = {
  siteId: number;
  assetId: number;
  payload: Record<string, unknown>;
};

export type MediaAssetMetadataFormUpdateInput = {
  siteId: number;
  assetId: number;
  folderId: number | null;
  title: string | null;
  altText: string | null;
  presentationFlags: number;
  focalRect?: unknown;
};

async function updateLoadedSiteMediaAsset(
  asset: MediaAssetRecord,
  payload: Record<string, unknown>,
) {
  const siteId = asset.siteId;
  const assetId = asset.id;

  const folderId = nullableInt(payload.folderId);
  if (
    Object.hasOwn(payload, "folderId") &&
    folderId !== null &&
    !await getMediaFolderBySiteAndId(siteId, asset.spaceId, folderId)
  ) {
    throw new MediaAssetUpdateError("Media Folder not found.", 404);
  }
  // Moving a file changes what both Folders hold, so neither may be locked.
  if (
    Object.hasOwn(payload, "folderId") &&
    folderId !== asset.folderId &&
    await hasLockedMediaFolder(siteId, asset.spaceId, [folderId, asset.folderId])
  ) {
    throw new MediaAssetUpdateError("The Media Folder is locked.", 409);
  }

  const title = Object.hasOwn(payload, "title") ? nullableString(payload.title) : undefined;
  const altText = Object.hasOwn(payload, "altText") ? nullableString(payload.altText) : undefined;
  const presentationFlags = Object.hasOwn(payload, "presentationFlags")
    ? flagsValue(payload.presentationFlags)
    : undefined;
  const meta = Object.hasOwn(payload, "meta") ? normalizedMeta(payload.meta) : undefined;
  if (Object.hasOwn(payload, "presentationFlags") && presentationFlags === null) {
    throw new MediaAssetUpdateError("Invalid presentationFlags value.", 400);
  }
  if (Object.hasOwn(payload, "meta") && meta === null) {
    throw new MediaAssetUpdateError("Invalid meta value.", 400);
  }

  const nextFocalRect = focalRect(meta ?? asset.meta);
  const focalRectChanged =
    Object.hasOwn(payload, "meta") &&
    !equalFocalRects(focalRect(asset.meta), nextFocalRect);
  const updated = await updateMediaAsset({
    siteId,
    spaceId: asset.spaceId,
    assetId,
    folderId: Object.hasOwn(payload, "folderId") ? folderId : undefined,
    variantVersion: focalRectChanged ? (nextFocalRect ? (asset.variantVersion ?? 0) + 1 : null) : undefined,
    title,
    altText,
    meta,
    presentationFlags: presentationFlags ?? undefined,
  });
  if (!updated) {
    throw new MediaAssetUpdateError("Media asset not found.", 404);
  }

  if (focalRectChanged) {
    const staleVariants = await deleteImageAssetVariantsByAssetId(updated.id);
    if (staleVariants.length > 0) {
      await Promise.all(
        staleVariants.map(async (variant) => {
          const profile = await getMediaStorageProfile(siteId, variant.storageProfileId);
          if (!profile) return false;
          const storage = await createPhisMediaStorageServiceForProfile(profile);
          return storage.deleteObject(variant.storageKey).catch(() => false);
        }),
      );
    }
  }
  clearSiteConfigCache(siteId);
  return updated;
}

export async function updateSiteMediaAsset(input: MediaAssetUpdateInput) {
  const asset = await getMediaAssetBySiteAndId(input.siteId, input.assetId);
  if (!asset) {
    throw new MediaAssetUpdateError("Media asset not found.", 404);
  }

  return updateLoadedSiteMediaAsset(asset, input.payload);
}

export async function updateSiteMediaAssetMetadataFromForm(
  input: MediaAssetMetadataFormUpdateInput,
) {
  const asset = await getMediaAssetBySiteAndId(input.siteId, input.assetId);
  if (!asset) {
    throw new MediaAssetUpdateError("Media asset not found.", 404);
  }

  const meta = { ...(asset.meta ?? {}) };
  if (Object.hasOwn(input, "focalRect")) {
    meta.focalRect = input.focalRect;
  }

  return updateLoadedSiteMediaAsset(asset, {
    folderId: input.folderId,
    title: input.title,
    altText: input.altText,
    presentationFlags: input.presentationFlags,
    meta,
  });
}
