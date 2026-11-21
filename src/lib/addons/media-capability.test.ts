import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaAssetRecord } from "@/db/media";

const state = vi.hoisted(() => ({
  read: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
}));
vi.mock("@/db/media", () => ({ listAddonReachMediaAssetsByIds: (...args: unknown[]) => state.read(...args) }));
vi.mock("@/db/media-spaces", async () => ({
  PhiMediaLifecycleStatus: { Ready: 2 },
  PhiMediaDeliveryPolicy: { Public: 1 },
  // The one constant the Media library's response builders read when they load; they stay unmocked, so the
  // paths here are the ones its listing gives.
  PhisMediaSpaceKind: (await vi.importActual<typeof import("@/lib/constants/media-space-kinds")>(
    "@/lib/constants/media-space-kinds",
  )).PhisMediaSpaceKind,
}));

import { buildPhisAddonMediaCapability } from "./media-capability.ts";
import { serializeMediaAssetForDetail } from "@/lib/media-response";

const ADDON = "@acme/shop";

const asset = (overrides: Partial<MediaAssetRecord>) => ({
  id: 9,
  siteId: 7,
  originalName: "cover.png",
  title: "Cover",
  contentType: "image/png",
  bytes: 2048,
  width: 640,
  height: 480,
  altText: "A cover",
  lifecycleStatus: 2,
  deliveryPolicy: 1,
  deliveryRevision: 3,
  variantVersion: 2,
  blurDataUrl: "data:image/webp;base64,AAAA",
  ...overrides,
}) as MediaAssetRecord;

const capability = (unauthenticated = false) => buildPhisAddonMediaCapability({ addonId: ADDON, siteId: 7, unauthenticated });

describe("media capability", () => {
  beforeEach(() => {
    state.read.mockReset().mockResolvedValue([]);
  });

  it("asks for the Assets in this Add-on's reach on its own Site, each id once", async () => {
    await capability().get({ ids: [9, 4, 9] });
    expect(state.read).toHaveBeenCalledWith(7, ADDON, [9, 4]);
  });

  it("answers a servable Asset with Core's delivery path and the facts an Add-on shows", async () => {
    state.read.mockResolvedValue([asset({})]);
    await expect(capability().get({ ids: [9] })).resolves.toEqual([{
      id: 9, name: "cover.png", title: "Cover", contentType: "image/png", byteSize: 2048, width: 640, height: 480,
      alt: "A cover", servable: true, path: "/api/site/media/9/content?r=3",
      thumbnailPath: "/api/site/media/9/variants/0?r=3&v=2",
      previewPath: "/api/site/media/9/variants/1?r=3&v=2",
      blurDataUrl: "data:image/webp;base64,AAAA",
    }]);
  });

  it("gives the variant paths the Media listing gives, from the same builders", async () => {
    const record = asset({ variantVersion: null });
    state.read.mockResolvedValue([record]);
    const [answer] = await capability().get({ ids: [9] });
    const tile = serializeMediaAssetForDetail(record);
    expect([answer?.thumbnailPath, answer?.previewPath]).toEqual([tile.thumbnailUrl, tile.previewUrl]);
    expect(answer?.thumbnailPath).toBe("/api/site/media/9/variants/0?r=3&v=0");
  });

  it("gives no variant paths for an Asset that is no image", async () => {
    state.read.mockResolvedValue([asset({ contentType: "application/pdf", originalName: "terms.pdf", title: null, blurDataUrl: null })]);
    const [answer] = await capability().get({ ids: [9] });
    expect(answer).toMatchObject({
      name: "terms.pdf", title: null, servable: true, path: "/api/site/media/9/content?r=3",
      thumbnailPath: null, previewPath: null, blurDataUrl: null,
    });
  });

  it("gives no path for an Asset a visitor is not served", async () => {
    state.read.mockResolvedValue([
      asset({ id: 1, lifecycleStatus: 1 }),
      asset({ id: 2, deliveryPolicy: 2 }),
    ]);
    const answer = await capability().get({ ids: [1, 2] });
    expect(answer.map((entry) => [entry.id, entry.servable, entry.path, entry.thumbnailPath, entry.previewPath]))
      .toEqual([[1, false, null, null, null], [2, false, null, null, null]]);
    expect(answer.map((entry) => entry.name)).toEqual(["cover.png", "cover.png"]);
  });

  it("keeps the order of the ids and leaves out what is not in reach", async () => {
    state.read.mockResolvedValue([asset({ id: 5 }), asset({ id: 3 })]);
    const answer = await capability().get({ ids: [3, 8, 5] });
    expect(answer.map((entry) => entry.id)).toEqual([3, 5]);
  });

  it("answers an unverified hook only what a visitor is served", async () => {
    state.read.mockResolvedValue([asset({ id: 1 }), asset({ id: 2, deliveryPolicy: 2 })]);
    const answer = await capability(true).get({ ids: [1, 2] });
    expect(answer.map((entry) => entry.id)).toEqual([1]);
  });

  it("refuses ids that are not a short list of positive integers, before asking anything", async () => {
    for (const ids of [[0], [-1], [1.5], ["9"], Array.from({ length: 201 }, (_, index) => index + 1)]) {
      await expect(capability().get({ ids: ids as number[] })).rejects.toThrow(/at most 200 positive integer/u);
    }
    await expect(capability().get({} as never)).rejects.toThrow(/at most 200/u);
    expect(state.read).not.toHaveBeenCalled();
  });

  it("answers an empty list without a query", async () => {
    await expect(capability().get({ ids: [] })).resolves.toEqual([]);
    expect(state.read).not.toHaveBeenCalled();
  });
});
