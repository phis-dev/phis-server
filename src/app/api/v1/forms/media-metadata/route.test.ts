import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import type { MediaAssetRecord } from "@/db/media";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  log: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteMediaApiContext: mocks.guard,
}));
vi.mock("@/lib/log", () => ({
  logRuntimeEvent: mocks.log,
}));
vi.mock("@/lib/media-asset-update", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/media-asset-update")>()),
  updateSiteMediaAssetMetadataFromForm: mocks.update,
}));

import { MediaAssetUpdateError } from "@/lib/media-asset-update";
import { POST } from "./route";

function asset(): MediaAssetRecord {
  return {
    id: 17,
    siteId: 7,
    spaceId: 2,
    folderId: 9,
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
    title: "Asset",
    altText: "Alternative",
    lifecycleStatus: 2,
    deliveryPolicy: 1,
    deliveryRevision: 1,
    presentationFlags: 9,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function request(body: unknown) {
  return new NextRequest("https://server.test/api/v1/forms/media-metadata", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue({
    context: {
      site: { id: 7, key: "example" },
      session: { userId: 3 },
      siteRole: { enabled: true },
      tokenMode: "internal",
    },
    error: null,
  });
  mocks.update.mockResolvedValue(asset());
});

describe("POST /api/v1/forms/media-metadata", () => {
  it("requires the canonical Site Builder API context", async () => {
    mocks.guard.mockResolvedValueOnce({
      context: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });

    const response = await POST(request({}));

    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects invalid identities, folders, and flags before updating", async () => {
    const invalidId = await POST(request({ assetId: 0, folderId: null, presentationFlags: [] }));
    const invalidFolder = await POST(request({ assetId: 17, folderId: "invalid", presentationFlags: [] }));
    const invalidFlags = await POST(request({ assetId: 17, folderId: null, presentationFlags: ["1024"] }));

    expect(invalidId.status).toBe(400);
    expect(invalidFolder.status).toBe(400);
    expect(invalidFlags.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("normalizes Form values and delegates one authorized metadata update", async () => {
    const response = await POST(request({
      assetId: "17",
      folderId: "9",
      title: " Product image ",
      altText: " Alternative text ",
      presentationFlags: ["1", "8"],
      focalRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
    }));

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      siteId: 7,
      assetId: 17,
      folderId: 9,
      title: "Product image",
      altText: "Alternative text",
      presentationFlags: 9,
      focalRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
    });
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: true,
      asset: expect.objectContaining({ id: 17, kind: "image" }),
    }));
  });

  it("does not clear focal metadata when the Form omits that field", async () => {
    await POST(request({
      assetId: 17,
      folderId: null,
      title: "Asset",
      altText: "",
      presentationFlags: [],
    }));

    expect(mocks.update).toHaveBeenCalledWith({
      siteId: 7,
      assetId: 17,
      folderId: null,
      title: "Asset",
      altText: null,
      presentationFlags: 0,
    });
  });

  it("preserves domain errors and logs unexpected failures", async () => {
    mocks.update.mockRejectedValueOnce(new MediaAssetUpdateError("Media asset not found.", 404));
    const notFound = await POST(request({ assetId: 17, folderId: null, presentationFlags: [] }));
    expect(notFound.status).toBe(404);
    expect(mocks.log).not.toHaveBeenCalled();

    mocks.update.mockRejectedValueOnce(new Error("database unavailable"));
    const failure = await POST(request({ assetId: 17, folderId: null, presentationFlags: [] }));
    expect(failure.status).toBe(500);
    expect(mocks.log).toHaveBeenCalledWith(
      "error",
      "media.asset.form_update_failed",
      expect.objectContaining({ siteKey: "example", userId: 3 }),
    );
  });
});
