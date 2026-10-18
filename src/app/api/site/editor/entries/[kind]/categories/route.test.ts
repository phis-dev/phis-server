import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  publisher: vi.fn(),
  author: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteAuthorApiContext: mocks.author,
  requireSitePublisherApiContext: mocks.publisher,
}));
vi.mock("@/db/site-content-terms", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/db/site-content-terms")>(),
  createSiteContentCategory: mocks.create,
  updateSiteContentCategory: mocks.update,
  deleteSiteContentCategory: mocks.remove,
  listSiteContentCategories: mocks.list,
}));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));

import { DELETE, GET, PUT } from "./route";

const SITE = { id: 4, key: "example" };
const PARAMS = { params: Promise.resolve({ kind: "blog" }) };
const CATEGORY = { id: 7, slug: "reisen", label: "Reisen", sortOrder: 0, entryCount: 0 };

function request(method: string, body?: unknown, query = "") {
  return new NextRequest(`https://server.test/api/site/editor/entries/blog/categories${query}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  const granted = { context: { site: SITE, session: { userId: 9 } }, error: null };
  mocks.publisher.mockResolvedValue(granted);
  mocks.author.mockResolvedValue(granted);
  mocks.create.mockResolvedValue(CATEGORY);
  mocks.update.mockResolvedValue(CATEGORY);
  mocks.remove.mockResolvedValue(true);
  mocks.list.mockResolvedValue([CATEGORY]);
});

/*
 * One `PUT` states a category whole, the way the entries route states an entry: without an id a new one,
 * with one that category. That is what lets one Form, relayed to a fixed address, write both.
 */
describe("PUT /api/site/editor/entries/blog/categories", () => {
  it("makes a new category where no id is named, the empty one of a Form's hidden field included", async () => {
    for (const body of [{ label: "Reisen" }, { id: "", label: "Reisen" }]) {
      const response = await PUT(request("PUT", body), PARAMS);
      expect(response.status).toBe(200);
    }
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ siteId: 4, slug: "reisen", label: "Reisen", sortOrder: 0 });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("corrects the category an id names, and says so where there is none", async () => {
    const response = await PUT(request("PUT", { id: "7", label: "Reisen & Essen", sortOrder: 2 }), PARAMS);
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0]![0]).toMatchObject({ id: 7, slug: "reisen-essen", sortOrder: 2 });

    mocks.update.mockResolvedValueOnce("missing");
    expect((await PUT(request("PUT", { id: 8, label: "Gone" }), PARAMS)).status).toBe(404);
  });

  it("refuses an id that is not one, rather than making a new category of it", async () => {
    for (const id of ["abc", 0, -3]) {
      expect((await PUT(request("PUT", { id, label: "Reisen" }), PARAMS)).status, String(id)).toBe(400);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 409 for an address another category has", async () => {
    mocks.create.mockResolvedValueOnce("slug_taken");
    expect((await PUT(request("PUT", { label: "Reisen" }), PARAMS)).status).toBe(409);
  });

  it("is the Publisher's", async () => {
    mocks.publisher.mockResolvedValueOnce({ context: null, error: new Response(null, { status: 403 }) });
    expect((await PUT(request("PUT", { label: "Reisen" }), PARAMS)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/site/editor/entries/blog/categories", () => {
  it("removes the category its id names", async () => {
    const response = await DELETE(request("DELETE", undefined, "?id=7"), PARAMS);
    expect(response.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith({ siteId: 4, type: expect.any(Number), id: 7 });
  });

  it("refuses without an id, and says so where there is none", async () => {
    expect((await DELETE(request("DELETE"), PARAMS)).status).toBe(400);
    mocks.remove.mockResolvedValueOnce(false);
    expect((await DELETE(request("DELETE", undefined, "?id=8"), PARAMS)).status).toBe(404);
  });
});

describe("GET /api/site/editor/entries/blog/categories", () => {
  it("lists them for whoever writes entries", async () => {
    const response = await GET(request("GET"), PARAMS);
    expect(await response.json()).toEqual({ categories: [CATEGORY], total: 1 });
    expect(mocks.author).toHaveBeenCalled();
  });
});
