import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteAuthorApiContext: mocks.guard,
}));
vi.mock("@/db/site-content", () => ({
  deleteSiteContentNews: mocks.remove,
  listSiteContentNewsForEditor: mocks.list,
  saveSiteContentNewsDraft: mocks.save,
}));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));

import { DELETE, GET, PATCH, POST } from "./route";

const SITE = { id: 4, key: "example", sourceLocale: "en" };

function request(method: string, body?: unknown, query = "") {
  return new NextRequest(`https://server.test/api/site/editor/news${query}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ENTRY = { slug: "a-slug", title: "A title", content: "A sentence." };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue({ context: { site: SITE, session: { userId: 9 } }, error: null });
  mocks.save.mockResolvedValue({ ok: true, contentId: 12, versionId: 34, slug: "a-slug" });
  mocks.list.mockResolvedValue([]);
});

describe("POST /api/site/editor/news", () => {
  it("saves a draft and never states when it is seen", async () => {
    const response = await POST(request("POST", ENTRY));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ contentId: 12, versionId: 34 });
    const [input] = mocks.save.mock.calls[0]!;
    expect(input).toMatchObject({ siteId: 4, slug: "a-slug", createdByUserId: 9, contentId: null });
    // The publication columns are the publisher's; nothing here may name them.
    expect(input).not.toHaveProperty("publishedAt");
    expect(input).not.toHaveProperty("status");
  });

  it("refuses an address that is not one", async () => {
    for (const slug of ["Not A Slug", "-leading-hyphen", "trailing space ", "slash/es", ""]) {
      const response = await POST(request("POST", { ...ENTRY, slug }));
      expect(response.status, slug).toBe(400);
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a link whose scheme nobody chose", async () => {
    for (const link of ["javascript:alert(1)", "//evil.test/path", "data:text/html,x", "mailto:a@b.test"]) {
      const response = await POST(request("POST", { ...ENTRY, link }));
      expect(response.status, link).toBe(400);
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("takes a site-relative path and an http(s) address", async () => {
    for (const link of ["/news/one", "https://example.test/a", "http://example.test/b"]) {
      const response = await POST(request("POST", { ...ENTRY, link }));
      expect(response.status, link).toBe(200);
    }
  });

  it("answers a taken address with 409 and an unknown entry with 404", async () => {
    mocks.save.mockResolvedValueOnce({ ok: false, reason: "slug_taken" });
    expect((await POST(request("POST", ENTRY))).status).toBe(409);

    mocks.save.mockResolvedValueOnce({ ok: false, reason: "missing" });
    expect((await PATCH(request("PATCH", { ...ENTRY, contentId: 12 }))).status).toBe(404);
  });

  it("drops duplicate tags and refuses more than the limit", async () => {
    await POST(request("POST", { ...ENTRY, tags: ["one", "one", " two "] }));
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ tags: ["one", "two"] });

    const tooMany = Array.from({ length: 13 }, (_, index) => `tag-${index}`);
    expect((await POST(request("POST", { ...ENTRY, tags: tooMany }))).status).toBe(400);
  });
});

describe("PATCH /api/site/editor/news", () => {
  it("needs the id of the entry it edits", async () => {
    const response = await PATCH(request("PATCH", { title: "A title", content: "A sentence." }));
    expect(response.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("leaves the address alone when the edit does not mention it", async () => {
    const response = await PATCH(request("PATCH", { contentId: 12, title: "T", content: "C" }));
    expect(response.status).toBe(200);
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ contentId: 12, slug: null });
  });
});

describe("DELETE /api/site/editor/news", () => {
  it("refuses to delete what is published and deletes what is not", async () => {
    mocks.remove.mockResolvedValueOnce("published");
    const refused = await DELETE(request("DELETE", undefined, "?contentId=12"));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "published" });

    mocks.remove.mockResolvedValueOnce("deleted");
    expect((await DELETE(request("DELETE", undefined, "?contentId=12"))).status).toBe(200);

    mocks.remove.mockResolvedValueOnce("missing");
    expect((await DELETE(request("DELETE", undefined, "?contentId=12"))).status).toBe(404);
  });
});

describe("GET /api/site/editor/news", () => {
  it("reads the Site's source locale, not a requested one", async () => {
    const response = await GET(request("GET", undefined, "?locale=de"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceLocale: "en" });
    expect(mocks.list).toHaveBeenCalledWith(4, "en");
  });

  it("answers with the guard's refusal", async () => {
    mocks.guard.mockResolvedValue({
      context: null,
      error: NextResponse.json({ error: "Forbidden." }, { status: 403 }),
    });
    expect((await GET(request("GET"))).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
