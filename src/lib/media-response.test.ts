import { describe, expect, it } from "vitest";

import type { MediaAssetRecord } from "@/db/media";
import { serializeMediaAssetForPublicReference } from "@/lib/media-response";

const asset: MediaAssetRecord = {
  id: 7,
  siteId: 31,
  spaceId: 3,
  folderId: 9,
  createdByUserId: 11,
  ownerUserId: 11,
  updatedByUserId: 12,
  storageProfileId: 2,
  storageKey: "sites/skeleton/9e85641d355f4786a2e9f2e6d18e3119",
  originalName: "cover.jpeg",
  contentType: "image/jpeg",
  variantVersion: 4,
  bytes: 812_345,
  checksumAlgorithm: null,
  checksumValue: null,
  width: 4032,
  height: 3024,
  blurDataUrl: "data:image/webp;base64,AAAA",
  meta: { focalRect: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 }, secretNote: "internal" },
  title: "Cover",
  altText: "A cover image",
  lifecycleStatus: 2,
  deliveryPolicy: 1,
  deliveryRevision: 3,
  presentationFlags: 8,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
};

const MANAGEMENT_ONLY_FIELDS = [
  "siteId", "spaceId", "folderId", "createdByUserId", "updatedByUserId", "ownerUserId",
  "storageProfileId", "storageKey", "bytes", "checksumSha256", "meta",
  "lifecycleStatus", "deliveryPolicy", "presentationFlags", "createdAt", "updatedAt",
] as const;

describe("public Asset reference projection", () => {
  it("carries the fields the public render path consumes", () => {
    expect(serializeMediaAssetForPublicReference(asset)).toEqual({
      id: 7,
      deliveryUrl: "/api/site/media/7/content?r=3",
      deliveryRevision: 3,
      variantVersion: 4,
      contentType: "image/jpeg",
      kind: "image",
      originalName: "cover.jpeg",
      width: 4032,
      height: 3024,
      blurDataUrl: "data:image/webp;base64,AAAA",
      title: "Cover",
      altText: "A cover image",
      thumbnailUrl: "/api/site/media/7/variants/0?r=3&v=4",
      previewUrl: "/api/site/media/7/variants/1?r=3&v=4",
      focalRect: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 },
      font: null,
    });
  });

  /*
   * The second `meta` entry a public render consumes, and the same rule as the focal rectangle: what a
   * Theme needs for a fallback face travels as a typed field, and the rest of the blob stays home.
   */
  it("carries the font metrics a Theme builds a fallback face from", () => {
    const projected = serializeMediaAssetForPublicReference({
      ...asset,
      contentType: "font/woff2",
      meta: {
        secretNote: "internal",
        font: {
          format: "woff2",
          familyName: "Phi Test Sans",
          unitsPerEm: 1000,
          ascent: 935,
          descent: -265,
          lineGap: 0,
          capHeight: 689,
          xHeight: 527,
          xWidthAvg: 460,
          xWidthAvgSource: "glyphs",
          category: "sans-serif",
        },
      },
    });
    expect(projected.kind).toBe("font");
    expect(projected.font).toEqual({
      format: "woff2",
      familyName: "Phi Test Sans",
      unitsPerEm: 1000,
      ascent: 935,
      descent: -265,
      lineGap: 0,
      capHeight: 689,
      xHeight: 527,
      xWidthAvg: 460,
      xWidthAvgSource: "glyphs",
      category: "sans-serif",
    });
  });

  it("refuses metrics without the grid the rest of them are measured on", () => {
    expect(serializeMediaAssetForPublicReference({
      ...asset,
      meta: { font: { unitsPerEm: 0, ascent: 935 } },
    }).font).toBeNull();
    expect(serializeMediaAssetForPublicReference({
      ...asset,
      meta: { font: { unitsPerEm: 1000, ascent: 935, category: "handwriting" } },
    }).font?.category).toBeNull();
  });

  it("never leaks a management or storage field", () => {
    const projected = serializeMediaAssetForPublicReference(asset) as Record<string, unknown>;
    for (const field of MANAGEMENT_ONLY_FIELDS) {
      expect(field in projected, field).toBe(false);
    }
  });

  it("projects the focal rectangle instead of the surrounding meta blob", () => {
    const serialized = JSON.stringify(serializeMediaAssetForPublicReference(asset));
    expect(serialized).not.toContain("secretNote");
    expect(serialized).not.toContain("internal");
  });

  it("clamps focal values into the 0..1 range and rejects incomplete rectangles", () => {
    const clamped = serializeMediaAssetForPublicReference({
      ...asset,
      meta: { focalRect: { x: -2, y: 7, width: 0.5, height: 0.5 } },
    });
    expect(clamped.focalRect).toEqual({ x: 0, y: 1, width: 0.5, height: 0.5 });

    for (const meta of [null, {}, { focalRect: null }, { focalRect: { x: 0.5 } }, { focalRect: [0.5] }]) {
      expect(serializeMediaAssetForPublicReference({ ...asset, meta }).focalRect).toBeNull();
    }
  });

  it("omits image variant urls for a non-image asset", () => {
    const document = serializeMediaAssetForPublicReference({
      ...asset,
      contentType: "application/pdf",
    });
    expect(document.kind).toBe("pdf");
    expect(document.thumbnailUrl).toBeNull();
    expect(document.previewUrl).toBeNull();
  });
});
