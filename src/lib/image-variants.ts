import "server-only";

import sharp, { type Sharp } from "sharp";

import { getImageAssetVariantByAssetIdAndKey, upsertImageAssetVariant, type MediaAssetRecord } from "@/db/media";
import {
  PhiMediaKind,
  resolvePhiImageAssetVariantKeyName,
  resolvePhiImageAssetVariantSpec,
  resolvePhiMediaKindFromContentType,
} from "@/lib/constants/media";
import { normalizeMediaFocalRect } from "@/db/media";
import type { PhisMediaObjectHead } from "@phis/contracts/addon";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { getMediaStorageProfile } from "@/db/media-spaces";

export type EnsureImageAssetVariantResult = {
  storageKey: string;
  byteSize: number;
  contentType: string;
  etag: string;
  width: number;
  height: number;
  variantKey: number;
  variantName: string | null;
  /**
   * The object as its storage answers for it, and that storage. The delivery route streams from here;
   * reading the variant row, the Profile and the head again after this cost it twice the work.
   */
  head: PhisMediaObjectHead;
  storage: Awaited<ReturnType<typeof createPhisMediaStorageServiceForProfile>>;
};

function buildVariantStorageKey(assetStorageKey: string, variantKey: number) {
  const normalizedAssetKey = assetStorageKey.trim().replace(/\/+$/g, "");
  return `${normalizedAssetKey}.__variants/${variantKey}.webp`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function resolveCoverCropBox(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  focalRect: ReturnType<typeof normalizeMediaFocalRect>,
) {
  const targetRatio = targetWidth / targetHeight;
  let cropWidth = sourceWidth;
  let cropHeight = Math.round(cropWidth / targetRatio);

  if (cropHeight > sourceHeight) {
    cropHeight = sourceHeight;
    cropWidth = Math.round(cropHeight * targetRatio);
  }

  cropWidth = Math.max(1, Math.min(sourceWidth, cropWidth));
  cropHeight = Math.max(1, Math.min(sourceHeight, cropHeight));

  let left = Math.round((sourceWidth - cropWidth) / 2);
  let top = Math.round((sourceHeight - cropHeight) / 2);

  if (focalRect) {
    const focalLeft = focalRect.x * sourceWidth;
    const focalTop = focalRect.y * sourceHeight;
    const focalRight = (focalRect.x + focalRect.width) * sourceWidth;
    const focalBottom = (focalRect.y + focalRect.height) * sourceHeight;
    const focalCenterX = (focalLeft + focalRight) / 2;
    const focalCenterY = (focalTop + focalBottom) / 2;

    left = Math.round(focalCenterX - cropWidth / 2);
    top = Math.round(focalCenterY - cropHeight / 2);

    if (cropWidth >= (focalRight - focalLeft)) {
      left = clamp(left, Math.ceil(focalRight - cropWidth), Math.floor(focalLeft));
    }
    if (cropHeight >= (focalBottom - focalTop)) {
      top = clamp(top, Math.ceil(focalBottom - cropHeight), Math.floor(focalTop));
    }
  }

  left = clamp(left, 0, Math.max(0, sourceWidth - cropWidth));
  top = clamp(top, 0, Math.max(0, sourceHeight - cropHeight));

  return {
    left,
    top,
    width: cropWidth,
    height: cropHeight,
  };
}

function sanitizeExtractArea(
  cropBox: ReturnType<typeof resolveCoverCropBox>,
  sourceWidth: number,
  sourceHeight: number,
) {
  const width = clamp(Math.trunc(cropBox.width), 1, sourceWidth);
  const height = clamp(Math.trunc(cropBox.height), 1, sourceHeight);
  const left = clamp(Math.trunc(cropBox.left), 0, Math.max(0, sourceWidth - width));
  const top = clamp(Math.trunc(cropBox.top), 0, Math.max(0, sourceHeight - height));

  return { left, top, width, height };
}

function resolveVariantContentType() {
  return "image/webp";
}

function isImageAsset(asset: MediaAssetRecord) {
  return resolvePhiMediaKindFromContentType(asset.contentType) === PhiMediaKind.Image;
}

export async function ensureImageAssetVariant(
  asset: MediaAssetRecord,
  variantKey: number,
): Promise<EnsureImageAssetVariantResult | null> {
  if (!isImageAsset(asset)) {
    return null;
  }

  const spec = resolvePhiImageAssetVariantSpec(variantKey);
  if (!spec) {
    return null;
  }

  const existing = await getImageAssetVariantByAssetIdAndKey(asset.id, variantKey);

  const createStorageService = async (storageProfileId: number) => {
    const profile = await getMediaStorageProfile(asset.siteId, storageProfileId);
    if (!profile) {
      throw new Error(`Media Storage Profile ${storageProfileId} is unavailable.`);
    }
    return await createPhisMediaStorageServiceForProfile(profile);
  };

  if (existing) {
    const existingStorageService = await createStorageService(existing.storageProfileId);
    const existingHead = await existingStorageService.headObject(existing.storageKey);
    if (existingHead) {
      return {
        storageKey: existing.storageKey,
        byteSize: existingHead.byteSize,
        contentType: existingHead.contentType,
        etag: existingHead.etag,
        width: existing.width,
        height: existing.height,
        variantKey: existing.variantKey,
        variantName: resolvePhiImageAssetVariantKeyName(existing.variantKey),
        head: existingHead,
        storage: existingStorageService,
      };
    }
  }

  const storageService = await createStorageService(asset.storageProfileId);
  const sourceBody = await storageService.getObject(asset.storageKey);
  if (!sourceBody) {
    return null;
  }

  const normalizedVariantKey = variantKey;
  const variantStorageKey = buildVariantStorageKey(asset.storageKey, normalizedVariantKey);
  const orientedSourceBody = await sharp(sourceBody, { failOn: "none" }).rotate().toBuffer();
  const sourceMetadata = await sharp(orientedSourceBody, { failOn: "none" }).metadata();
  const focalRect = normalizeMediaFocalRect(asset.meta && typeof asset.meta === "object" ? asset.meta.focalRect : null);

  let pipeline = sharp(orientedSourceBody, { failOn: "none" });
  let fallbackPipeline: Sharp | null = null;
  if (
    focalRect &&
    sourceMetadata.width &&
    sourceMetadata.height &&
    spec.fit === "cover"
  ) {
    const cropBox = resolveCoverCropBox(
      sourceMetadata.width,
      sourceMetadata.height,
      spec.width,
      spec.height,
      focalRect,
    );
    const extractArea = sanitizeExtractArea(cropBox, sourceMetadata.width, sourceMetadata.height);
    fallbackPipeline = sharp(orientedSourceBody, { failOn: "none" }).resize(spec.width, spec.height, {
      fit: spec.fit,
      withoutEnlargement: true,
    });
    pipeline = pipeline.extract(extractArea).resize(spec.width, spec.height, {
      fit: "fill",
      withoutEnlargement: true,
    });
  } else {
    pipeline = pipeline.resize(spec.width, spec.height, {
      fit: spec.fit,
      withoutEnlargement: true,
      background: spec.fit === "contain" ? { r: 0, g: 0, b: 0, alpha: 0 } : undefined,
    });
  }

  pipeline = pipeline.webp({ quality: spec.quality });
  fallbackPipeline = fallbackPipeline?.webp({ quality: spec.quality }) ?? null;

  let rendered: Awaited<ReturnType<typeof pipeline.toBuffer>>;
  try {
    rendered = await pipeline.toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (!fallbackPipeline) {
      throw error;
    }
    rendered = await fallbackPipeline.toBuffer({ resolveWithObject: true });
  }
  const storedObject = await storageService.putObject({
    storageKey: variantStorageKey,
    body: rendered.data,
    contentType: resolveVariantContentType(),
    metadata: {
      assetId: String(asset.id),
      siteId: String(asset.siteId),
      sourceStorageKey: asset.storageKey,
      variantKey: String(normalizedVariantKey),
      variantName: resolvePhiImageAssetVariantKeyName(normalizedVariantKey) ?? "",
    },
  });

  await upsertImageAssetVariant({
    assetId: asset.id,
    variantKey: normalizedVariantKey,
    storageProfileId: asset.storageProfileId,
    storageKey: storedObject.storageKey,
    contentType: storedObject.contentType,
    bytes: storedObject.byteSize,
    // What the Provider can attest, not what its ETag happens to hold.
    checksumAlgorithm: storedObject.checksum?.algorithm ?? null,
    checksumValue: storedObject.checksum?.value ?? null,
    width: rendered.info.width ?? spec.width,
    height: rendered.info.height ?? spec.height,
    blurDataUrl: null,
  });

  return {
    storageKey: storedObject.storageKey,
    byteSize: storedObject.byteSize,
    contentType: storedObject.contentType,
    etag: storedObject.etag,
    width: rendered.info.width ?? spec.width,
    height: rendered.info.height ?? spec.height,
    variantKey: normalizedVariantKey,
    variantName: resolvePhiImageAssetVariantKeyName(normalizedVariantKey),
    head: storedObject,
    storage: storageService,
  };
}
