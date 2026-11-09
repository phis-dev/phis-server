import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  site: vi.fn(),
  search: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: mocks.guard, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/db/site-search", () => ({ searchSiteDocuments: mocks.search }));

import { GET } from "./route";

async function read(query: string, headers: Record<string, string> = {}) {
  const response = await GET(new NextRequest(`https://site.test/api/v1/site/search?${query}`, { headers }));
  return { status: response.status, body: await response.json() };
}

/*
 * The Site asks on behalf of a visitor, naming the Areas that visitor may search; phis answers the
 * Pages matching, in the request's language. The query's admission is the contract's: a query too
 * short to be one is an empty answer, not a refusal.
 */
describe("the Site search read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockReturnValue(null);
    mocks.site.mockResolvedValue({ id: 31, key: "skeleton" });
    mocks.search.mockResolvedValue({ hits: [{ path: "/docs", title: "Docs" }], total: 1 });
  });

  it("searches the Public Area in the request's locale by default", async () => {
    const { status, body } = await read("q=install", { "x-locale": "de" });

    expect(status).toBe(200);
    expect(mocks.search).toHaveBeenCalledWith({ siteId: 31, areaMask: 1, locale: "de", query: "install", limit: 20 });
    expect(body).toMatchObject({ query: "install", locale: "de", areaMask: 1, total: 1 });
    expect(body.hits).toHaveLength(1);
  });

  it("searches the Areas the Site names", async () => {
    const { status, body } = await read("q=install&areas=app,public&limit=5");

    expect(status).toBe(200);
    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ areaMask: 3, limit: 5 }));
    expect(body.areaMask).toBe(3);
  });

  it("refuses an Area that is not indexed", async () => {
    expect((await read("q=install&areas=admin")).status).toBe(400);
    expect((await read("q=install&areas=shop")).status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("refuses a limit outside the contract", async () => {
    expect((await read("q=install&limit=0")).status).toBe(400);
    expect((await read("q=install&limit=51")).status).toBe(400);
    expect((await read("q=install&limit=ten")).status).toBe(400);
  });

  it("answers nothing for a query too short to be one, without asking the database", async () => {
    const { status, body } = await read("q=%20a%20");

    expect(status).toBe(200);
    expect(body).toMatchObject({ query: "", hits: [], total: 0 });
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("reads the query as the contract does", async () => {
    await read(`q=${encodeURIComponent("  phis   server  ")}`);

    expect(mocks.search).toHaveBeenCalledWith(expect.objectContaining({ query: "phis server" }));
  });

  it("is for the Site alone", async () => {
    const refused = new Response(null, { status: 401 });
    mocks.guard.mockReturnValue(refused);

    const response = await GET(new NextRequest("https://site.test/api/v1/site/search?q=install"));

    expect(response).toBe(refused);
    expect(mocks.guard).toHaveBeenCalledWith(expect.anything(), { requireInternalToken: true });
  });
});
