import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  site: vi.fn(),
  pages: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: mocks.guard, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/db/site-pages", () => ({ listSitePublishedPageAddresses: mocks.pages }));

import { GET } from "./route";

const request = () => new NextRequest("https://site.test/api/v1/site/public-pages");

/*
 * The sitemap's candidates. The list is Public's alone -- the staff Areas' addresses are what the Site
 * keeps out of its robots.txt, so they must not be one internal request away either.
 */
describe("Listing a Site's published Public Pages", () => {
  it("asks for the Public Area and nothing else", async () => {
    mocks.guard.mockReturnValue(null);
    mocks.site.mockResolvedValue({ id: 31, key: "skeleton" });
    mocks.pages.mockResolvedValue([
      { path: "/kontakt", ownerModuleId: null, presetKey: null, publishedAt: "2026-09-01T10:00:00.000Z" },
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.pages).toHaveBeenCalledWith(31, 1);
    expect(await response.json()).toEqual({
      pages: [{ path: "/kontakt", ownerModuleId: null, presetKey: null, publishedAt: "2026-09-01T10:00:00.000Z" }],
    });
  });

  it("answers nothing without the internal token", async () => {
    mocks.pages.mockClear();
    mocks.guard.mockReturnValue(NextResponse.json({ error: "Unauthorized." }, { status: 401 }));

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.pages).not.toHaveBeenCalled();
  });
});
