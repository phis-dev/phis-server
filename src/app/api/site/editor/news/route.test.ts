import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  tags: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteAuthorApiContext: mocks.guard,
}));
/*
 * The store's own module, with only the three writes replaced. `normalizePhiNewsTag` stays the real one:
 * what a tag is has one definition, and a copy of it here would let this test pass while the route and the
 * store disagreed about the very thing it pins.
 */
vi.mock("@/db/site-content", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/site-content")>()),
  deleteSiteContentNews: mocks.remove,
  listSiteContentNewsForEditor: mocks.list,
  listSiteContentNewsTagsInUse: mocks.tags,
  saveSiteContentNewsDraft: mocks.save,
}));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));

import { DELETE, GET, PUT } from "./route";

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
  mocks.list.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 });
  mocks.tags.mockResolvedValue(["release"]);
});

describe("PUT /api/site/editor/news, as a save", () => {
  it("saves a draft and never states when it is seen", async () => {
    const response = await PUT(request("PUT", ENTRY));

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
      const response = await PUT(request("PUT", { ...ENTRY, slug }));
      expect(response.status, slug).toBe(400);
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a link whose scheme nobody chose", async () => {
    for (const link of ["javascript:alert(1)", "//evil.test/path", "data:text/html,x", "mailto:a@b.test"]) {
      const response = await PUT(request("PUT", { ...ENTRY, link }));
      expect(response.status, link).toBe(400);
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("takes a site-relative path and an http(s) address", async () => {
    for (const link of ["/news/one", "https://example.test/a", "http://example.test/b"]) {
      const response = await PUT(request("PUT", { ...ENTRY, link }));
      expect(response.status, link).toBe(200);
    }
  });

  it("answers a taken address with 409 and an unknown entry with 404", async () => {
    mocks.save.mockResolvedValueOnce({ ok: false, reason: "slug_taken" });
    expect((await PUT(request("PUT", ENTRY))).status).toBe(409);

    mocks.save.mockResolvedValueOnce({ ok: false, reason: "missing" });
    expect((await PUT(request("PUT", { ...ENTRY, contentId: 12 }))).status).toBe(404);
  });

  it("normalises tags, drops duplicates and refuses more than the limit", async () => {
    // Trimmed and lower-cased, because the string is the tag's identity: two spellings would be two tags
    // with two translations to pay for.
    await PUT(request("PUT", { ...ENTRY, tags: ["One", " one ", "TWO", "two"] }));
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ tags: ["one", "two"] });

    const tooMany = Array.from({ length: 13 }, (_, index) => `tag-${index}`);
    expect((await PUT(request("PUT", { ...ENTRY, tags: tooMany }))).status).toBe(400);
  });
});

describe("the language a save declares", () => {
  it("passes a stated language through, normalised", async () => {
    const response = await PUT(request("PUT", { ...ENTRY, sourceLocale: "DE" }));

    expect(response.status).toBe(200);
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ sourceLocale: "de", translate: true });
  });

  it("reads no language as the Site's own", async () => {
    await PUT(request("PUT", ENTRY));
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ sourceLocale: null, translate: true });
  });

  it("refuses a language this installation cannot translate", async () => {
    const response = await PUT(request("PUT", { ...ENTRY, sourceLocale: "kli" }));

    expect(response.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("takes a stated no to translating", async () => {
    await PUT(request("PUT", { ...ENTRY, translate: false }));
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ translate: false });

    // A string is the other spelling a stored value arrives in.
    await PUT(request("PUT", { ...ENTRY, translate: "false" }));
    expect(mocks.save.mock.calls[1]![0]).toMatchObject({ translate: false });
  });

  /*
   * The contradiction: not translatable and not in the Site's language would be answered in that language
   * to every reader, including the ones who cannot read it.
   */
  it("refuses a foreign language that may not be translated", async () => {
    const response = await PUT(request("PUT", { ...ENTRY, sourceLocale: "de", translate: false }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "untranslatable_foreign_source" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("allows the Site's own language to be stated and not translated", async () => {
    const response = await PUT(request("PUT", { ...ENTRY, sourceLocale: "en", translate: false }));

    expect(response.status).toBe(200);
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ sourceLocale: "en", translate: false });
  });
});

describe("PUT /api/site/editor/news, on an entry that exists", () => {
  it("needs an id or an address: without either there is no entry to state", async () => {
    const response = await PUT(request("PUT", { title: "A title", content: "A sentence." }));
    expect(response.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  /*
   * One method for both, because a Form binds one handler: with an id it is that entry, without one it is
   * a new entry at the slug it names.
   */
  it("creates at the named address when no id comes with it", async () => {
    const response = await PUT(request("PUT", ENTRY));

    expect(response.status).toBe(200);
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ contentId: null, slug: "a-slug" });
  });

  it("leaves the address alone when the save does not mention it", async () => {
    const response = await PUT(request("PUT", { contentId: 12, title: "T", content: "C" }));
    expect(response.status).toBe(200);
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ contentId: 12, slug: null });
  });

  /*
   * A save states the whole entry, and this is the test that says so out loud. It was written after a
   * measurement against the dev stand: a save that corrected a title and named neither `link` nor `tags`
   * left the published entry without either, and nothing in the surface admitted that was the rule.
   */
  it("clears what it does not state, because a version is not a patch", async () => {
    await PUT(request("PUT", { contentId: 12, title: "T", content: "C" }));
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({
      subtitle: null, link: null, tags: [], sortOrder: 0,
    });
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
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ siteId: 4, locale: "en" }));
  });

  it("pages, searches and filters as the Table asks", async () => {
    await GET(request("GET", undefined, "?page=3&pageSize=10&search=probe&status=draft"));

    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({
      page: 3, pageSize: 10, search: "probe", status: 0,
    }));
  });

  it("reads an unknown status as no filter at all", async () => {
    await GET(request("GET", undefined, "?status=whatever"));
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ status: null }));

    await GET(request("GET", undefined, "?status=published"));
    expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: 1 }));
  });

  it("answers the total and the tags in use beside the page", async () => {
    mocks.list.mockResolvedValue({
      rows: [{ contentId: 12, slug: "a-slug" }], total: 41, page: 2, pageSize: 20,
    });
    const body = await (await GET(request("GET"))).json();

    expect(body).toMatchObject({ total: 41, page: 2, pageSize: 20, tags: ["release"] });
    expect(body.entries).toHaveLength(1);
  });

  it("answers with the guard's refusal", async () => {
    mocks.guard.mockResolvedValue({
      context: null,
      error: NextResponse.json({ error: "Forbidden." }, { status: 403 }),
    });
    expect((await GET(request("GET"))).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.tags).not.toHaveBeenCalled();
  });
});
