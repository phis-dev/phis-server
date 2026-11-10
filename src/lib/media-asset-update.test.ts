import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaAssetRecord } from "@/db/media";

const mocks = vi.hoisted(() => ({
  clearSiteConfigCache: vi.fn(),
  deleteImageAssetVariantsByAssetId: vi.fn(),
  findMediaFolderPathId: vi.fn(),
  deleteObject: vi.fn(),
  getMediaAssetBySiteAndId: vi.fn(),
  getMediaFolderBySiteAndId: vi.fn(),
  getMediaStorageProfile: vi.fn(),
  hasLockedMediaFolder: vi.fn(),
  updateMediaAsset: vi.fn(),
}));
vi.mock("@/db/media-spaces", () => ({
  getMediaStorageProfile: mocks.getMediaStorageProfile,
}));

vi.mock("@/db/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/media")>()),
  deleteImageAssetVariantsByAssetId: mocks.deleteImageAssetVariantsByAssetId,
  findMediaFolderPathId: mocks.findMediaFolderPathId,
  getMediaAssetBySiteAndId: mocks.getMediaAssetBySiteAndId,
  getMediaFolderBySiteAndId: mocks.getMediaFolderBySiteAndId,
  hasLockedMediaFolder: mocks.hasLockedMediaFolder,
  updateMediaAsset: mocks.updateMediaAsset,
}));
vi.mock("@/db/site-config", () => ({
  clearSiteConfigCache: mocks.clearSiteConfigCache,
}));
vi.mock("@/lib/media-storage", () => ({
  createPhisMediaStorageServiceForProfile: () => ({ deleteObject: mocks.deleteObject }),
}));

import {
  updateSiteMediaAsset,
  updateSiteMediaAssetMetadataFromForm,
} from "./media-asset-update";

function asset(overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
  return {
    id: 17,
    siteId: 7,
    spaceId: 2,
    folderId: 4,
    createdByUserId: 3,
    ownerUserId: 3,
    updatedByUserId: 3,
    storageProfileId: 5,
    variantVersion: 2,
    storageKey: "sites/example/image.jpg",
    originalName: "image.jpg",
    contentType: "image/jpeg",
    bytes: 128,
    checksumAlgorithm: null,
  checksumValue: null,
    width: 1200,
    height: 800,
    blurDataUrl: null,
    meta: {
      attribution: "Example",
      focalRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
    },
    title: "Before",
    altText: "Before alt",
    lifecycleStatus: 2,
    deliveryPolicy: 1,
    deliveryRevision: 1,
    presentationFlags: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // No Folder is locked unless a test says so; the real reader would ask the database.
  mocks.hasLockedMediaFolder.mockResolvedValue(false);
  const current = asset();
  mocks.getMediaAssetBySiteAndId.mockResolvedValue(current);
  mocks.getMediaFolderBySiteAndId.mockResolvedValue({ id: 4 });
  mocks.getMediaStorageProfile.mockResolvedValue({ providerId: "@phis/server/storage-local", config: {} });
  mocks.updateMediaAsset.mockImplementation(async (input: Record<string, unknown>) =>
    asset({
      folderId: input.folderId as number | null | undefined ?? current.folderId,
      variantVersion: Object.hasOwn(input, "variantVersion")
        ? input.variantVersion as number | null
        : current.variantVersion,
      title: input.title as string | null | undefined ?? current.title,
      altText: input.altText as string | null | undefined ?? current.altText,
      meta: input.meta as Record<string, unknown> | null | undefined ?? current.meta,
      presentationFlags: input.presentationFlags as number | undefined ?? current.presentationFlags,
    }),
  );
  mocks.deleteImageAssetVariantsByAssetId.mockResolvedValue([]);
  mocks.deleteObject.mockResolvedValue(true);
});

describe("updateSiteMediaAsset", () => {
  it("keeps the existing PATCH business behavior in the shared update service", async () => {
    const updated = await updateSiteMediaAsset({
      siteId: 7,
      assetId: 17,
      payload: {
        folderId: 9,
        title: " Updated ",
        altText: " Updated alt ",
        presentationFlags: 8,
      },
    });

    expect(mocks.getMediaFolderBySiteAndId).toHaveBeenCalledWith(7, 2, 9);
    expect(mocks.updateMediaAsset).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 7,
      spaceId: 2,
      assetId: 17,
      folderId: 9,
      title: "Updated",
      altText: "Updated alt",
      presentationFlags: 8,
    }));
    expect(mocks.deleteImageAssetVariantsByAssetId).not.toHaveBeenCalled();
    expect(mocks.clearSiteConfigCache).toHaveBeenCalledWith(7);
    expect(updated.title).toBe("Updated");
  });

  it("rejects invalid metadata before writing", async () => {
    await expect(updateSiteMediaAsset({
      siteId: 7,
      assetId: 17,
      payload: { meta: { focalRect: { x: -1, y: 0, width: 1, height: 1 } } },
    })).rejects.toMatchObject({
      message: "Invalid meta value.",
      status: 400,
    });

    expect(mocks.updateMediaAsset).not.toHaveBeenCalled();
  });

  it("does not move an asset into an unknown folder", async () => {
    mocks.getMediaFolderBySiteAndId.mockResolvedValueOnce(null);
    await expect(updateSiteMediaAsset({
      siteId: 7,
      assetId: 17,
      payload: { folderId: 99 },
    })).rejects.toMatchObject({
      message: "Media Folder not found.",
      status: 404,
    });
    expect(mocks.updateMediaAsset).not.toHaveBeenCalled();
  });

  it("invalidates generated variants when the focal rectangle changes", async () => {
    mocks.deleteImageAssetVariantsByAssetId.mockResolvedValue([
      { storageProfileId: 5, storageKey: "variants/preview.webp" },
      { storageProfileId: 5, storageKey: "variants/card.webp" },
    ]);

    await updateSiteMediaAsset({
      siteId: 7,
      assetId: 17,
      payload: {
        meta: {
          attribution: "Example",
          focalRect: { x: 0.2, y: 0.2, width: 0.5, height: 0.4 },
        },
      },
    });

    expect(mocks.updateMediaAsset).toHaveBeenCalledWith(expect.objectContaining({
      variantVersion: 3,
    }));
    expect(mocks.deleteImageAssetVariantsByAssetId).toHaveBeenCalledWith(17);
    expect(mocks.deleteObject).toHaveBeenCalledTimes(2);
    expect(mocks.deleteObject).toHaveBeenCalledWith("variants/preview.webp");
    expect(mocks.deleteObject).toHaveBeenCalledWith("variants/card.webp");
  });
});

describe("updateSiteMediaAssetMetadataFromForm", () => {
  it("preserves unrelated metadata and an omitted focal rectangle", async () => {
    await updateSiteMediaAssetMetadataFromForm({
      siteId: 7,
      assetId: 17,
      folderId: null,
      title: "Asset",
      altText: null,
      presentationFlags: 1,
    });

    expect(mocks.updateMediaAsset).toHaveBeenCalledWith(expect.objectContaining({
      folderId: null,
      meta: {
        attribution: "Example",
        focalRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
      },
    }));
    expect(mocks.deleteImageAssetVariantsByAssetId).not.toHaveBeenCalled();
  });

  it("removes a cleared focal rectangle and invalidates old variants", async () => {
    await updateSiteMediaAssetMetadataFromForm({
      siteId: 7,
      assetId: 17,
      folderId: null,
      title: "Asset",
      altText: null,
      presentationFlags: 0,
      focalRect: null,
    });

    expect(mocks.updateMediaAsset).toHaveBeenCalledWith(expect.objectContaining({
      variantVersion: null,
      meta: { attribution: "Example" },
    }));
    expect(mocks.deleteImageAssetVariantsByAssetId).toHaveBeenCalledWith(17);
  });
});
