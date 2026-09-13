import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  site: vi.fn(),
  preset: vi.fn(),
  pages: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: mocks.guard, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/lib/guards/site-admin-api", () => ({ requireSiteCmsPreviewApiContext: vi.fn() }));
vi.mock("@/db/site-pages", () => ({
  getExactSiteAreaPresetTree: mocks.preset,
  getSiteAreaDraftRevisionPreview: vi.fn(),
  getSiteAreaRevisionReview: vi.fn(),
  listSitePublishedPageAddresses: mocks.pages,
}));

import { GET } from "./route";

const sourcePreset = { ownerModuleId: "@phis/ui/modules/public", presetKey: "public-area-preset" };
const page = {
  path: "/kontakt",
  ownerModuleId: null,
  presetKey: null,
  revisionId: 184,
  publishedAt: "2026-09-01T10:00:00.000Z",
};

function request(query: string) {
  return new NextRequest(
    `https://site.test/api/v1/site/area?ownerModuleId=${encodeURIComponent(sourcePreset.ownerModuleId)}`
      + `&presetKey=${sourcePreset.presetKey}&${query}`,
  );
}

async function read(query: string) {
  const response = await GET(request(query));
  return { status: response.status, body: await response.json() };
}

/*
 * The sitemap asks the Public Area read for its published Pages instead of a route of its own. That
 * read is what every page view pays for, so the list has to stay out of it unless it was asked for --
 * and it has to stay Public's, because the staff Areas' addresses are what robots.txt does not name.
 */
describe("the Area read with its published Pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockReturnValue(null);
    mocks.site.mockResolvedValue({ id: 31, key: "skeleton" });
    mocks.preset.mockResolvedValue({ sourcePreset, preset: { config: {} } });
    mocks.pages.mockResolvedValue([page]);
  });

  it("does not list Pages on the ordinary live read", async () => {
    const { status, body } = await read("path=/");

    expect(status).toBe(200);
    expect(body).not.toHaveProperty("publishedPages");
    expect(mocks.pages).not.toHaveBeenCalled();
  });

  it("lists the Public Area's published Pages beside the preset when asked", async () => {
    const { status, body } = await read("path=/&include=publishedPages");

    expect(status).toBe(200);
    expect(mocks.pages).toHaveBeenCalledWith(31, 1);
    expect(body.publishedPages).toEqual([page]);
    expect(body.preset).toEqual({ sourcePreset, preset: { config: {} } });
  });

  it("still lists them while the Area has never been published", async () => {
    // Pages can be published before their Area is; without the list those would never be in a sitemap.
    mocks.preset.mockResolvedValue(null);
    const { status, body } = await read("path=/&include=publishedPages");

    expect(status).toBe(200);
    expect(body.preset).toBeNull();
    expect(body.publishedPages).toEqual([page]);
  });

  it("refuses the list for any Area but Public, for a draft, and for an unknown include", async () => {
    expect((await read("path=/admin&include=publishedPages")).status).toBe(400);
    expect((await read("path=/&include=publishedPages&revision=7")).status).toBe(400);
    expect((await read("path=/&include=navigation")).status).toBe(400);
    expect(mocks.pages).not.toHaveBeenCalled();
  });
});
