import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  site: vi.fn(),
  live: vi.fn(),
  preview: vi.fn(),
  review: vi.fn(),
  pages: vi.fn(),
  previewContext: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: mocks.guard, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/lib/guards/site-admin-api", () => ({ requireSiteCmsPreviewApiContext: mocks.previewContext }));
vi.mock("@/db/site-pages", () => ({
  getSiteAreaLiveRead: mocks.live,
  getSiteAreaDraftRevisionPreview: mocks.preview,
  getSiteAreaRevisionReview: mocks.review,
  listSitePublishedPageAddresses: mocks.pages,
}));

import { GET } from "./route";

const sourcePreset = { ownerModuleId: "@phis/ui/modules/public", presetKey: "public-area-preset" };
const identityQuery = `ownerModuleId=${encodeURIComponent(sourcePreset.ownerModuleId)}&presetKey=${sourcePreset.presetKey}`;
const tree = { sourcePreset: { ...sourcePreset, sourcePresetVersion: 3 }, preset: { config: {} } };
const modules = { revisionId: 41, config: { modules: { runtimeModules: ["@acme/shop/modules/shop"] } } };
const page = {
  path: "/kontakt",
  ownerModuleId: null,
  presetKey: null,
  revisionId: 184,
  publishedAt: "2026-09-01T10:00:00.000Z",
};

async function read(query: string, { identity = true } = {}) {
  const response = await GET(new NextRequest(
    `https://site.test/api/v1/site/area?${identity ? `${identityQuery}&` : ""}${query}`,
  ));
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockReturnValue(null);
  mocks.site.mockResolvedValue({ id: 31, key: "skeleton" });
  mocks.live.mockResolvedValue({ preset: tree, modules });
  mocks.pages.mockResolvedValue([page]);
  mocks.previewContext.mockResolvedValue({ context: { site: { id: 31 } }, error: null });
});

/*
 * The Module selection decides which shell an Area takes, so it is answered whatever identity is asked
 * for -- and without one -- while a named identity gets the structure only if it is stored under it, and
 * no identity gets the stored structure under its own.
 */
describe("the live Area read", () => {
  it("answers the selection beside the structure stored under the named identity", async () => {
    const { status, body } = await read("path=/");

    expect(status).toBe(200);
    expect(mocks.live).toHaveBeenCalledWith(31, 1, expect.objectContaining({ sourcePreset, stage: "published" }));
    expect(body).toEqual({ areaMask: 1, sourcePreset: tree.sourcePreset, preset: tree, modules });
  });

  it("answers the stored structure under its own identity when none is named", async () => {
    const { status, body } = await read("path=/", { identity: false });

    expect(status).toBe(200);
    expect(mocks.live).toHaveBeenCalledWith(31, 1, expect.objectContaining({ sourcePreset: null }));
    expect(body).toEqual({ areaMask: 1, sourcePreset: tree.sourcePreset, preset: tree, modules });
  });

  it("answers an Area that stores nothing rather than a 404", async () => {
    mocks.live.mockResolvedValue({ preset: null, modules: null });
    const { status, body } = await read("path=/");

    expect(status).toBe(200);
    expect(body).toEqual({ areaMask: 1, sourcePreset: null, preset: null, modules: null });
  });

  it("refuses half an identity", async () => {
    const response = await GET(new NextRequest(
      `https://site.test/api/v1/site/area?path=/&ownerModuleId=${encodeURIComponent(sourcePreset.ownerModuleId)}`,
    ));
    expect(response.status).toBe(400);
    expect(mocks.live).not.toHaveBeenCalled();
  });

  it("answers a reviewed Modules revision as the selection, beside the live structure", async () => {
    const draftModules = { revisionId: 57, config: { modules: { runtimeModules: [] } } };
    mocks.review.mockResolvedValue({ revisionId: 57, preset: tree, modules: draftModules });
    const { status, body } = await read("path=/&reviewKind=area&reviewRevision=57");

    expect(status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith(31, 57, { areaMask: 1, sourcePreset });
    expect(body).toEqual({ areaMask: 1, sourcePreset: tree.sourcePreset, preset: tree, modules: draftModules, revisionId: 57 });
  });

  it("answers 404 for a preview revision that is not there", async () => {
    mocks.preview.mockResolvedValue(null);
    expect((await read("path=/&revision=58")).status).toBe(404);
  });
});

/*
 * The sitemap asks the Public Area read for its published Pages instead of a route of its own. That
 * read is what every page view pays for, so the list has to stay out of it unless it was asked for --
 * and it has to stay Public's, because the staff Areas' addresses are what robots.txt does not name.
 */
describe("the Area read with its published Pages", () => {
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
    expect(body.preset).toEqual(tree);
    expect(body.modules).toEqual(modules);
  });

  it("still lists them while the Area has never been published", async () => {
    // Pages can be published before their Area is; without the list those would never be in a sitemap.
    mocks.live.mockResolvedValue({ preset: null, modules: null });
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
