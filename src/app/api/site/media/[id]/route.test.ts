import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { MediaAssetRecord } from "@/db/media";

const mocks = vi.hoisted(() => ({
  mediaContext: vi.fn(),
  update: vi.fn(),
}));

// The route is guarded per Asset now: Site Media authority still passes, and so does an Author acting
// on what they own. Which of the two it was is settled inside the guard, so the test stands in for the
// answer rather than for either path.
vi.mock("@/lib/guards/site-media-api", () => ({
  requireMediaAssetContext: mocks.mediaContext,
}));
vi.mock("@/db/media", () => ({
  deleteImageAssetVariantsByAssetId: vi.fn(),
  deleteMediaAssetBySite: vi.fn(),
  getMediaAssetBySiteAndId: vi.fn(),
  pruneEmptyMediaFolderBranch: vi.fn(),
}));
vi.mock("@/db/site-config", () => ({ clearSiteConfigCache: vi.fn() }));
vi.mock("@/db/user-sessions", () => ({ getSessionFromRequest: vi.fn() }));
vi.mock("@/lib/media-delete-guard", () => ({ collectMediaAssetDeleteReferences: vi.fn() }));
vi.mock("@/lib/media-storage", () => ({ PhisMediaStorageService: vi.fn() }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));
vi.mock("@/lib/media-asset-update", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/media-asset-update")>()),
  updateSiteMediaAsset: mocks.update,
}));

import { MediaAssetUpdateError } from "@/lib/media-asset-update";
import { PATCH } from "./route";

function asset(): MediaAssetRecord {
  return {
    id: 17,
    siteId: 7,
    spaceId: 2,
    folderId: null,
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
    meta: null,
    title: "Updated",
    altText: null,
    lifecycleStatus: 2,
    deliveryPolicy: 1,
    deliveryRevision: 1,
    presentationFlags: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mediaContext.mockResolvedValue({
    site: { id: 7, key: "example" },
    session: { id: 1, userId: 3 },
    error: null,
  });
  mocks.update.mockResolvedValue(asset());
});

describe("PATCH /api/site/media/:id", () => {
  it("keeps the existing route contract while delegating update behavior", async () => {
    const request = new NextRequest("https://server.test/api/site/media/17", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Updated" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ id: "17" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      siteId: 7,
      assetId: 17,
      payload: { title: "Updated" },
    });
    expect(await response.json()).toEqual(expect.objectContaining({
      asset: expect.objectContaining({ id: 17, kind: "image" }),
    }));
  });

  it("preserves shared domain validation status codes", async () => {
    mocks.update.mockRejectedValueOnce(new MediaAssetUpdateError("Invalid meta value.", 400));
    const request = new NextRequest("https://server.test/api/site/media/17", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meta: "invalid" }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ id: "17" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid meta value." });
  });
});
