import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaAssetRecord } from "@/db/media";
import { PhiImageAssetVariantKey } from "@/lib/constants/media";

const mocks = vi.hoisted(() => ({
  getImageAssetVariantByAssetIdAndKey: vi.fn(),
  upsertImageAssetVariant: vi.fn(),
  getMediaStorageProfile: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
}));

vi.mock("@/db/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/media")>()),
  getImageAssetVariantByAssetIdAndKey: mocks.getImageAssetVariantByAssetIdAndKey,
  upsertImageAssetVariant: mocks.upsertImageAssetVariant,
}));
vi.mock("@/db/media-spaces", () => ({
  getMediaStorageProfile: mocks.getMediaStorageProfile,
}));
vi.mock("@/lib/media-storage", () => ({
  createPhisMediaStorageServiceForProfile: async () => ({
    getObject: mocks.getObject,
    putObject: mocks.putObject,
  }),
}));

import { ensureImageAssetVariant } from "./image-variants";

function asset(overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
  return {
    id: 17,
    siteId: 7,
    spaceId: 2,
    folderId: null,
    createdByUserId: 3,
    ownerUserId: 3,
    updatedByUserId: 3,
    storageProfileId: 5,
    variantVersion: 0,
    storageKey: "sites/example/picture.png",
    originalName: "picture.png",
    contentType: "image/png",
    bytes: 128,
    checksumAlgorithm: null,
    checksumValue: null,
    width: 600,
    height: 400,
    blurDataUrl: null,
    meta: null,
    title: null,
    altText: null,
    lifecycleStatus: 1,
    deliveryPolicy: 1,
    deliveryRevision: 0,
    presentationFlags: 0,
    createdAt: "2026-11-24T00:00:00.000Z",
    updatedAt: "2026-11-24T00:00:00.000Z",
    ...overrides,
  };
}

/** A half-transparent picture smaller than every large variant. */
async function smallTransparentPng() {
  return sharp({ create: { width: 600, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toBuffer();
}

describe("ensureImageAssetVariant", () => {
  beforeEach(async () => {
    mocks.getImageAssetVariantByAssetIdAndKey.mockResolvedValue(null);
    mocks.getMediaStorageProfile.mockResolvedValue({ id: 5 });
    mocks.getObject.mockResolvedValue(await smallTransparentPng());
    mocks.putObject.mockImplementation(async (input: { storageKey: string; body: Buffer; contentType: string }) => ({
      storageKey: input.storageKey,
      byteSize: input.body.byteLength,
      contentType: input.contentType,
      etag: "etag",
      checksum: null,
      lastModifiedAt: "2026-11-24T00:00:00.000Z",
    }));
  });

  it("renders the share variant as a JPEG of exactly 1200 x 630, a smaller original enlarged and laid on white", async () => {
    const result = await ensureImageAssetVariant(asset(), PhiImageAssetVariantKey.Share);

    expect(result).toMatchObject({ width: 1200, height: 630, contentType: "image/jpeg", variantName: "share" });
    const stored = mocks.putObject.mock.calls[0]![0] as { storageKey: string; body: Buffer; contentType: string };
    expect(stored.storageKey).toBe("sites/example/picture.png.__variants/11.jpg");
    expect(stored.contentType).toBe("image/jpeg");
    const { data, info } = await sharp(stored.body).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ format: "raw", width: 1200, height: 630, channels: 3 });
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
    expect(mocks.upsertImageAssetVariant).toHaveBeenCalledWith(expect.objectContaining({
      variantKey: PhiImageAssetVariantKey.Share,
      contentType: "image/jpeg",
      width: 1200,
      height: 630,
    }));
  });

  it("crops the share variant around the focal rectangle and still states its exact box", async () => {
    const result = await ensureImageAssetVariant(
      asset({ meta: { focalRect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } }),
      PhiImageAssetVariantKey.Share,
    );

    expect(result).toMatchObject({ width: 1200, height: 630 });
  });

  it("keeps every other variant a WebP no larger than its original", async () => {
    const result = await ensureImageAssetVariant(asset(), PhiImageAssetVariantKey.Hero);

    expect(result).toMatchObject({ width: 600, height: 400, contentType: "image/webp" });
    const stored = mocks.putObject.mock.calls[0]![0] as { storageKey: string };
    expect(stored.storageKey).toBe("sites/example/picture.png.__variants/5.webp");
  });
});
