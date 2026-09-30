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
vi.mock("@/db/site-content", () => ({
  listPublishedNews: mocks.list,
  PHI_NEWS_TRANSLATION_CONTEXTS: {
    title: "news entry title",
    subtitle: "news entry subtitle",
    content: "news entry body",
  },
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
    tags: [],
    sourceLocale: null,
    translate: true,
    ...overrides,
  };
}

function request(locale = "en") {
  return new Request("https://server.test/api/v1/news", { headers: { "x-locale": locale } });
}

async function read(locale = "en") {
  const response = await GET(request(locale));
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

describe("GET /api/v1/news", () => {
  it("asks for nothing when the reader's language is the one the entry was written in", async () => {
    const { body } = await read("en");

    expect(mocks.translateSite).not.toHaveBeenCalled();
    expect(mocks.translateExternal).not.toHaveBeenCalled();
    expect(body.news[0]).toMatchObject({ title: "An entry", subtitle: "Its subtitle" });
  });

  it("translates title and subtitle for another language, each under its own context", async () => {
    const { body } = await read("de");

    expect(mocks.translateSite).toHaveBeenCalledTimes(2);
    const contexts = mocks.translateSite.mock.calls.map(([input]) => input.ctx);
    expect(contexts).toEqual(["news entry title", "news entry subtitle"]);
    expect(mocks.translateSite.mock.calls[0]![0]).toMatchObject({
      siteId: 3, locale: "de", sourceLocale: "en", format: "text",
    });
    expect(body.news[0]).toMatchObject({ title: "de:An entry", subtitle: "de:Its subtitle" });
  });

  /*
   * The body is not here on purpose: Markdown is translated paragraph by paragraph where it is rendered,
   * so what this answers is the source, beside the language it was written in.
   */
  it("answers the body as written, with the language beside it", async () => {
    const { body } = await read("de");

    expect(body.news[0].content).toBe("# Its body\n\nA paragraph.");
    expect(body.news[0]).toMatchObject({ sourceLocale: null, translate: true });
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
    expect(body.news[0].title).toBe("en:An entry");
  });

  it("asks for nothing when the reader speaks the language the entry was written in", async () => {
    mocks.list.mockResolvedValue([entry({ sourceLocale: "de" })]);
    const { body } = await read("de");

    expect(mocks.translateExternal).not.toHaveBeenCalled();
    expect(body.news[0].title).toBe("An entry");
  });

  it("respects a stated no to translating", async () => {
    mocks.list.mockResolvedValue([entry({ translate: false })]);
    const { body } = await read("de");

    expect(mocks.translateSite).not.toHaveBeenCalled();
    expect(body.news[0].title).toBe("An entry");
  });

  it("leaves a field somebody already translated alone", async () => {
    mocks.list.mockResolvedValue([entry({ title: { text: "Ein Eintrag", source: "An entry", translated: true } })]);
    const { body } = await read("de");

    expect(mocks.translateSite).toHaveBeenCalledTimes(1);
    expect(mocks.translateSite.mock.calls[0]![0].ctx).toBe("news entry subtitle");
    expect(body.news[0].title).toBe("Ein Eintrag");
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
    expect(body.news[0].title).toBe("An entry");
    expect(body.provisional).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the answer when nothing stood in", async () => {
    const { response } = await read("de");
    expect(response.headers.get("cache-control")).toContain("max-age=300");
  });
});
