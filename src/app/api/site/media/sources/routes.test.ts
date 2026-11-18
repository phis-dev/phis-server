import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ guard: vi.fn(), write: vi.fn(), list: vi.fn(), page: vi.fn(), take: vi.fn() }));

vi.mock("@/lib/guards/site-media-api", () => ({
  requireMediaManagementSiteContext: mocks.guard,
  requireMediaSpaceWriteContext: mocks.write,
}));
vi.mock("@/db/media-spaces", () => ({ ensureSiteMediaSpace: vi.fn() }));
vi.mock("@/lib/media-response", () => ({ serializeMediaAssetForTile: (a: { id: number }) => ({ tile: a.id }) }));
vi.mock("@/lib/media-sources", () => {
  class MediaSourceError extends Error {
    constructor(readonly code: string, message: string, readonly status: number) {
      super(message);
    }
  }
  return {
    MediaSourceError,
    listMediaSources: mocks.list,
    listMediaSourcePage: mocks.page,
    importMediaSourceItem: mocks.take,
  };
});

import { GET as listSources } from "./route";
import { GET as listItems } from "./items/route";
import { POST as importItem } from "./import/route";
import { MediaSourceError } from "@/lib/media-sources";

const site = { id: 1, key: "acme", defaultLocale: "de" };
const get = (path: string) => new NextRequest(`http://core.test${path}`);
const post = (body: unknown) => new NextRequest("http://core.test/api/site/media/sources/import", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
});
const Err = MediaSourceError as unknown as new (code: string, message: string, status: number) => Error;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue({ site, session: { userId: 5 }, siteWide: true, error: null });
  mocks.write.mockResolvedValue({ site, session: { userId: 5 }, siteWide: true, error: null });
});

describe("media source routes", () => {
  it("list the sources", async () => {
    mocks.list.mockResolvedValue([{ source: "p#a", label: "A" }]);
    const response = await listSources(get("/api/site/media/sources"));
    expect(await response.json()).toEqual({ rows: [{ source: "p#a", label: "A" }] });
  });

  it("pass the guard's refusal through", async () => {
    const refusal = new Response(null, { status: 403 });
    mocks.guard.mockResolvedValue({ site: null, session: null, siteWide: false, error: refusal });
    expect(await listSources(get("/api/site/media/sources"))).toBe(refusal);
  });

  it("ask a page with the request's parameters and the Site's locale as the fallback", async () => {
    mocks.page.mockResolvedValue({ items: [], nextCursor: null });
    const response = await listItems(get("/api/site/media/sources/items?source=p%23a&q=sea&kind=image&kind=video&cursor=c&limit=5"));
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(mocks.page).toHaveBeenCalledWith({
      site: { id: 1, key: "acme" }, source: "p#a", query: "sea", kinds: ["image", "video"], cursor: "c", limit: 5, locale: "de",
    });
  });

  it("refuse a listing without a source with 400, and map the library's errors to their statuses", async () => {
    expect((await listItems(get("/api/site/media/sources/items"))).status).toBe(400);
    for (const [code, status] of [["media_source_not_found", 404], ["media_source_unusable", 409], ["media_source_failed", 502]] as const) {
      mocks.page.mockRejectedValue(new Err(code, "m", status));
      const response = await listItems(get("/api/site/media/sources/items?source=p%23a"));
      expect(response.status).toBe(status);
      expect((await response.json()).error).toBe(code);
    }
  });

  it("import by item id and answer the Asset as a tile", async () => {
    mocks.take.mockResolvedValue({ id: 9 });
    const response = await importItem(post({ source: "p#a", itemId: "i1", folderId: 3, title: "ignored" }));
    expect(await response.json()).toEqual({ asset: { tile: 9 } });
    expect(mocks.take).toHaveBeenCalledWith({ site: { id: 1, key: "acme" }, source: "p#a", itemId: "i1", folderId: 3, actorUserId: 5 });
  });

  it("refuse a malformed import and map refusals", async () => {
    expect((await importItem(post({ source: "p#a" }))).status).toBe(400);
    expect((await importItem(post({ source: "p#a", itemId: "i", folderId: "x" }))).status).toBe(400);
    mocks.take.mockRejectedValue(new Err("folder_locked", "locked", 409));
    const response = await importItem(post({ source: "p#a", itemId: "i" }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("folder_locked");
  });
});
