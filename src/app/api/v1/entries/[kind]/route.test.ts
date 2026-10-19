import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  site: vi.fn(),
  translateSite: vi.fn(),
  translateExternal: vi.fn(),
  standIn: { value: false },
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: () => null }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/db/site-content-entries", () => ({
  isSiteContentEntryKind: (value: unknown) => value === "news",
  listPublishedSiteContentEntries: (_kind: string, ...args: unknown[]) => mocks.list(...args),
  SITE_CONTENT_ENTRY_KINDS: { news: { type: 0, contexts: {
    title: "news entry title",
    subtitle: "news entry subtitle",
    content: "news entry body",
    tag: "news tag",
    category: "news category",
  } } },
}));
vi.mock("@/lib/media-response", () => ({
  resolvePhiMediaThumbnailUrl: ({ id }: { id: number }) => `/api/site/media/${id}/variants/1`,
}));
vi.mock("@/lib/translations", () => ({
  translateSiteBatchWithCache: mocks.translateSite,
  translateExternalSiteBatchWithCache: mocks.translateExternal,
  trackTranslationStandIns: async (work: () => Promise<unknown>) => ({
    value: await work(),
    standIn: mocks.standIn.value,
  }),
}));
vi.mock("@/lib/log", () => ({
  logRuntimeEvent: vi.fn(),
  normalizeLogThrowable: (error: unknown) => error,
}));

import { GET } from "./route";

const SITE = { id: 3, key: "example", sourceLocale: "en" };

function field(text: string, translated = false) {
  return { text, source: text, translated };
}

function tag(label: string) {
  return { slug: label, label };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "an-entry",
    slug: "an-entry",
    created: "2026-09-01T08:00:00.000Z",
    outdated: null,
    title: field("An entry"),
    subtitle: field("Its subtitle"),
    content: field("# Its body\n\nA paragraph."),
    link: null,
    category: null,
    tags: [],
    author: null,
    sourceLocale: null,
    translate: true,
    ...overrides,
  };
}

function request(locale = "en", query = "") {
  return new Request(`https://server.test/api/v1/entries/news${query}`, { headers: { "x-locale": locale } });
}

async function read(locale = "en") {
  const response = await GET(request(locale), { params: Promise.resolve({ kind: "news" }) });
  return { status: response.status, body: await response.json(), response };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.standIn.value = false;
  mocks.site.mockResolvedValue(SITE);
  mocks.list.mockResolvedValue([entry()]);
  mocks.translateSite.mockImplementation(async ({ msgs }: { msgs: string[] }) =>
    msgs.map((msg) => `de:${msg}`));
  mocks.translateExternal.mockImplementation(async ({ msgs }: { msgs: string[] }) =>
    msgs.map((msg) => `en:${msg}`));
});

describe("GET /api/v1/entries/news", () => {
  it("hands a stated limit to the read, so the cut comes before the translating", async () => {
    const response = await GET(request("en", "?limit=10"), { params: Promise.resolve({ kind: "news" }) });
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(SITE.id, "en", { limit: 10 });
  });

  it("reads everything when no limit is stated", async () => {
    await GET(request("en"), { params: Promise.resolve({ kind: "news" }) });
    expect(mocks.list).toHaveBeenCalledWith(SITE.id, "en", {});
  });

  it("refuses a limit that is not a count", async () => {
    for (const query of ["?limit=0", "?limit=-1", "?limit=ten", "?limit=2.5"]) {
      const response = await GET(request("en", query), { params: Promise.resolve({ kind: "news" }) });
      expect(response.status, query).toBe(400);
    }
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("hands the categories to the read, filed under none among them where the list says so", async () => {
    await GET(request("en", "?limit=5&categories=3,none,7"), { params: Promise.resolve({ kind: "news" }) });
    expect(mocks.list).toHaveBeenCalledWith(SITE.id, "en", {
      limit: 5,
      categories: { categoryIds: [3, 7], uncategorized: true },
    });
  });

  it("refuses a category list with anything but ids and none in it", async () => {
    for (const query of ["?categories=travel", "?categories=3,0", "?categories=-1", "?categories=1.5"]) {
      const response = await GET(request("en", query), { params: Promise.resolve({ kind: "news" }) });
      expect(response.status, query).toBe(400);
    }
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("asks for nothing when the reader's language is the one the entry was written in", async () => {
    const { body } = await read("en");

    expect(mocks.translateSite).not.toHaveBeenCalled();
    expect(mocks.translateExternal).not.toHaveBeenCalled();
    expect(body.entries[0]).toMatchObject({ title: "An entry", subtitle: "Its subtitle" });
  });

  it("translates title and subtitle for another language, each under its own context", async () => {
    const { body } = await read("de");

    expect(mocks.translateSite).toHaveBeenCalledTimes(2);
    const contexts = mocks.translateSite.mock.calls.map(([input]) => input.ctx);
    expect(contexts).toEqual(["news entry title", "news entry subtitle"]);
    expect(mocks.translateSite.mock.calls[0]![0]).toMatchObject({
      siteId: 3, locale: "de", sourceLocale: "en", format: "text",
    });
    expect(body.entries[0]).toMatchObject({ title: "de:An entry", subtitle: "de:Its subtitle" });
  });

  /*
   * The body is not here on purpose: Markdown is translated paragraph by paragraph where it is rendered,
   * so what this answers is the source, beside the language it was written in.
   */
  it("answers the body as written, with the language beside it", async () => {
    const { body } = await read("de");

    expect(body.entries[0].content).toBe("# Its body\n\nA paragraph.");
    expect(body.entries[0]).toMatchObject({ sourceLocale: null, translate: true });
    for (const call of mocks.translateSite.mock.calls) {
      expect(call[0].msgs).not.toContain("# Its body\n\nA paragraph.");
    }
  });

  it("takes the external route for an entry written in another language", async () => {
    mocks.list.mockResolvedValue([entry({ sourceLocale: "de" })]);
    const { body } = await read("fr");

    expect(mocks.translateSite).not.toHaveBeenCalled();
    expect(mocks.translateExternal.mock.calls[0]![0]).toMatchObject({
      locale: "fr", sourceLocale: "de", canonicalLocale: "en",
    });
    expect(body.entries[0].title).toBe("en:An entry");
  });

  it("asks for nothing when the reader speaks the language the entry was written in", async () => {
    mocks.list.mockResolvedValue([entry({ sourceLocale: "de" })]);
    const { body } = await read("de");

    expect(mocks.translateExternal).not.toHaveBeenCalled();
    expect(body.entries[0].title).toBe("An entry");
  });

  it("respects a stated no to translating", async () => {
    mocks.list.mockResolvedValue([entry({ translate: false })]);
    const { body } = await read("de");

    expect(mocks.translateSite).not.toHaveBeenCalled();
    expect(body.entries[0].title).toBe("An entry");
  });

  it("leaves a field somebody already translated alone", async () => {
    mocks.list.mockResolvedValue([entry({ title: { text: "Ein Eintrag", source: "An entry", translated: true } })]);
    const { body } = await read("de");

    expect(mocks.translateSite).toHaveBeenCalledTimes(1);
    expect(mocks.translateSite.mock.calls[0]![0].ctx).toBe("news entry subtitle");
    expect(body.entries[0].title).toBe("Ein Eintrag");
  });

  it("asks once for every entry that needs the same language and context", async () => {
    mocks.list.mockResolvedValue([
      entry({ slug: "one", subtitle: field("") }),
      entry({ slug: "two", subtitle: field("") }),
    ]);
    await read("de");

    expect(mocks.translateSite).toHaveBeenCalledTimes(1);
    expect(mocks.translateSite.mock.calls[0]![0].msgs).toHaveLength(2);
  });

  it("translates the tags too, under their own context", async () => {
    mocks.list.mockResolvedValue([entry({ tags: [tag("release"), tag("modules")] })]);
    const { body } = await read("de");

    const tagCall = mocks.translateSite.mock.calls
      .find(([input]) => input.ctx === "news tag");
    expect(tagCall?.[0]).toMatchObject({ msgs: ["release", "modules"], format: "text" });
    // The label is read; the address stays as written, because it is the term's identity.
    expect(body.entries[0].tags).toEqual([
      { slug: "release", label: "de:release" },
      { slug: "modules", label: "de:modules" },
    ]);
  });

  it("translates the category under its own context", async () => {
    mocks.list.mockResolvedValue([entry({ category: { slug: "press", label: "Press" } })]);
    const { body } = await read("de");

    const call = mocks.translateSite.mock.calls.find(([input]) => input.ctx === "news category");
    expect(call?.[0].msgs).toEqual(["Press"]);
    expect(body.entries[0].category).toEqual({ slug: "press", label: "de:Press" });
  });

  it("names an author with a picture by its delivery address, and nothing else about them", async () => {
    mocks.list.mockResolvedValue([entry({
      author: { name: "Ada", avatar: { assetId: 41, deliveryRevision: 2, variantVersion: 1, contentType: "image/png" } },
    })]);
    const { body } = await read("en");
    expect(body.entries[0].author).toEqual({ name: "Ada", avatar: { url: "/api/site/media/41/variants/1" } });
  });

  /*
   * One message for the same word, however many entries carry it: the label is the message, so a context
   * naming the entry would make a Site pay for "release" once per entry.
   */
  it("asks once for a tag two entries share", async () => {
    mocks.list.mockResolvedValue([
      entry({ slug: "one", subtitle: field(""), tags: [tag("release")] }),
      entry({ slug: "two", subtitle: field(""), tags: [tag("release")] }),
    ]);
    await read("de");

    const tagCalls = mocks.translateSite.mock.calls.filter(([input]) => input.ctx === "news tag");
    expect(tagCalls).toHaveLength(1);
    expect(tagCalls[0]![0].msgs).toEqual(["release", "release"]);
  });

  it("leaves the tags as written when the entry may not be translated", async () => {
    mocks.list.mockResolvedValue([entry({ translate: false, tags: [tag("mehrsprachig")] })]);
    const { body } = await read("de");

    expect(mocks.translateSite).not.toHaveBeenCalled();
    expect(body.entries[0].tags).toEqual([tag("mehrsprachig")]);
  });

  it("marks a stand-in as provisional and refuses to have it kept", async () => {
    mocks.standIn.value = true;
    const { body, response } = await read("de");

    expect(body.provisional).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers in the source language when translating throws, and says so", async () => {
    mocks.translateSite.mockRejectedValue(new Error("provider down"));
    const { status, body, response } = await read("de");

    expect(status).toBe(200);
    expect(body.entries[0].title).toBe("An entry");
    expect(body.provisional).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the answer when nothing stood in", async () => {
    const { response } = await read("de");
    expect(response.headers.get("cache-control")).toContain("max-age=300");
  });
});
