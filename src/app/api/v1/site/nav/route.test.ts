import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  site: vi.fn(),
  preview: vi.fn(),
  published: vi.fn(),
  revision: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: mocks.guard, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/lib/guards/site-admin-api", () => ({ requireSiteCmsPreviewApiContext: mocks.preview }));
vi.mock("@/db/site-navigation", () => ({
  getPublishedSiteNavigationOverlay: mocks.published,
  getSiteNavigationOverlayRevisionById: mocks.revision,
  projectSiteNavigationOverlayTargets: async (_siteId: number, overlay: unknown) => overlay,
}));

import { GET } from "./route";

const overlay = { navKey: "public:header", items: [] };

async function read(query: string) {
  const response = await GET(new NextRequest(`https://site.test/api/v1/site/nav?key=public:header&${query}`));
  return { status: response.status, body: await response.json() };
}

/*
 * A Site asks for navigation with the internal token on behalf of whoever is looking at the page. The
 * published overlay is for everyone; a revision by id can be a draft, so it is only for a visitor whose
 * session may preview CMS work -- the same bar as a review, whichever of the two parameters asked.
 */
describe("the navigation read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockReturnValue(null);
    mocks.site.mockResolvedValue({ id: 31, key: "skeleton" });
    mocks.published.mockResolvedValue(overlay);
    mocks.revision.mockResolvedValue({ ...overlay, items: [{ id: "draft" }] });
    mocks.preview.mockResolvedValue({
      context: null,
      error: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
  });

  it("serves the published overlay without a session", async () => {
    const { status, body } = await read("");

    expect(status).toBe(200);
    expect(body.overlay).toEqual(overlay);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("refuses a revision by id without a preview session", async () => {
    const { status } = await read("revision=7");

    expect(status).toBe(401);
    expect(mocks.revision).not.toHaveBeenCalled();
  });

  it("refuses a navigation review without a preview session", async () => {
    const { status } = await read("reviewKind=navigation&reviewRevision=7");

    expect(status).toBe(401);
    expect(mocks.revision).not.toHaveBeenCalled();
  });

  it("serves a revision by id to a preview session", async () => {
    mocks.preview.mockResolvedValue({ context: { site: { id: 31 } }, error: null });
    const { status, body } = await read("revision=7");

    expect(status).toBe(200);
    expect(mocks.revision).toHaveBeenCalledWith(31, "public:header", 7);
    expect(body.overlay.items).toEqual([{ id: "draft" }]);
  });
});
