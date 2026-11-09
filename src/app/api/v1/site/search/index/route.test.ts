import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  site: vi.fn(),
  replace: vi.fn(),
  states: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: mocks.guard, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/db/site-search", async () => {
  const actual = await vi.importActual<typeof import("@/db/site-search")>("@/db/site-search");
  return {
    readSiteSearchDocument: actual.readSiteSearchDocument,
    replaceSiteSearchDocuments: mocks.replace,
    listSiteSearchIndexStates: mocks.states,
  };
});
vi.mock("@/lib/db", () => ({ getPool: vi.fn(), withTransaction: vi.fn() }));

import { GET, PUT } from "./route";

const state = { areaMask: 1, locale: "en", fingerprint: "f1", documentCount: 1, indexedAt: "2026-11-08T10:00:00.000Z" };

async function put(body: unknown) {
  const response = await PUT(new NextRequest("https://site.test/api/v1/site/search/index", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

/*
 * The Site writes what it read of its Pages, one Area and language at a time; phis keeps it. The
 * fingerprint is the Site's word for "built from this", and the same word twice is one write.
 */
describe("the Site search index write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockReturnValue(null);
    mocks.site.mockResolvedValue({ id: 31, key: "skeleton" });
    mocks.replace.mockResolvedValue({ status: "written", state });
    mocks.states.mockResolvedValue([state]);
  });

  it("replaces the set of one Area and language", async () => {
    const { status, body } = await put({
      area: "public",
      locale: "en",
      fingerprint: "f1",
      documents: [{ path: "/docs", title: "Docs", description: "", text: "Install phis." }],
    });

    expect(status).toBe(200);
    expect(mocks.replace).toHaveBeenCalledWith(
      { siteId: 31, areaMask: 1, locale: "en" },
      "f1",
      [{ path: "/docs", title: "Docs", description: "", text: "Install phis." }],
    );
    expect(body).toEqual({ accepted: true, state, dropped: 0 });
  });

  it("says when the set was already held", async () => {
    mocks.replace.mockResolvedValue({ status: "unchanged", state });

    const { body } = await put({ area: "public", locale: "en", fingerprint: "f1", documents: [] });

    expect(body.accepted).toBe(false);
  });

  it("drops a document that is not one and writes the rest", async () => {
    const { body } = await put({
      area: "app",
      locale: "de",
      fingerprint: "f2",
      documents: [
        { path: "/a", title: "A", description: "", text: "" },
        { title: "No path" },
        { path: "relative", title: "Not an address" },
      ],
    });

    expect(mocks.replace).toHaveBeenCalledWith(
      { siteId: 31, areaMask: 2, locale: "de" },
      "f2",
      [{ path: "/a", title: "A", description: "", text: "" }],
    );
    expect(body.dropped).toBe(2);
  });

  it("refuses a set that names no indexed Area, locale or fingerprint", async () => {
    expect((await put({ area: "editor", locale: "en", fingerprint: "f", documents: [] })).status).toBe(400);
    expect((await put({ area: "public", locale: "", fingerprint: "f", documents: [] })).status).toBe(400);
    expect((await put({ area: "public", locale: "en", fingerprint: "", documents: [] })).status).toBe(400);
    expect((await put({ area: "public", locale: "en", fingerprint: "f" })).status).toBe(400);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("passes the set module's refusal on", async () => {
    mocks.replace.mockResolvedValue({ status: "invalid", reason: "Nope." });

    const { status, body } = await put({ area: "public", locale: "en", fingerprint: "f", documents: [] });

    expect(status).toBe(400);
    expect(body.error).toBe("Nope.");
  });

  it("lists the sets phis holds", async () => {
    const response = await GET(new NextRequest("https://site.test/api/v1/site/search/index"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sets: [state] });
    expect(mocks.states).toHaveBeenCalledWith(31);
  });
});
