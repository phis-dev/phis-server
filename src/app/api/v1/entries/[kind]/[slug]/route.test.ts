import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  related: vi.fn(),
  site: vi.fn(),
  translateSite: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: () => null }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/db/site-content-entries", () => ({
  isSiteContentEntryKind: (value: unknown) => value === "blog",
  readPublishedSiteContentEntry: (_kind: string, ...args: unknown[]) => mocks.read(...args),
  listRelatedSiteContentEntries: (_kind: string, ...args: unknown[]) => mocks.related(...args),
  SITE_CONTENT_ENTRY_KINDS: { blog: { type: 8, contexts: {
    title: "blog post title",
    subtitle: "blog post teaser",
    content: "blog post body",
    tag: "blog tag",
    category: "blog category",
  } } },
}));
vi.mock("@/lib/translations", () => ({
  translateSiteBatchWithCache: mocks.translateSite,
  translateExternalSiteBatchWithCache: vi.fn(),
  trackTranslationStandIns: async (work: () => Promise<unknown>) => ({ value: await work(), standIn: false }),
}));
vi.mock("@/lib/media-response", () => ({ resolvePhiMediaThumbnailUrl: () => null }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn(), normalizeLogThrowable: (error: unknown) => error }));

import { GET } from "./route";

const SITE = { id: 3, key: "example", sourceLocale: "en" };

function post(slug: string, contentId: number) {
  const field = (text: string) => ({ text, source: text, translated: false });
  return {
    contentId,
    id: slug,
    slug,
    created: "2026-09-01T08:00:00.000Z",
    outdated: null,
    title: field(`Title ${slug}`),
    subtitle: field(""),
    content: field("Body."),
    link: null,
    category: null,
    tags: [],
    author: null,
    sourceLocale: null,
    translate: true,
  };
}

async function read(slug: string, query = "", locale = "en") {
  const response = await GET(
    new Request(`https://server.test/api/v1/entries/blog/${slug}${query}`, { headers: { "x-locale": locale } }),
    { params: Promise.resolve({ kind: "blog", slug }) },
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.site.mockResolvedValue(SITE);
  mocks.read.mockResolvedValue(post("a-post", 7));
  mocks.related.mockResolvedValue([post("b-post", 8), post("c-post", 9)]);
  mocks.translateSite.mockImplementation(async ({ msgs }: { msgs: string[] }) => msgs.map((msg) => `de:${msg}`));
});

describe("GET /api/v1/entries/blog/<slug>", () => {
  it("answers 404 where nothing published answers at the address", async () => {
    mocks.read.mockResolvedValue(null);
    expect((await read("gone")).status).toBe(404);
  });

  it("answers the entry alone unless its relatives are asked for", async () => {
    const { status, body } = await read("a-post");
    expect(status).toBe(200);
    expect(body.entry).toMatchObject({ slug: "a-post", title: "Title a-post" });
    expect(body.related).toBeUndefined();
    expect(mocks.related).not.toHaveBeenCalled();
  });

  it("asks for the relatives of the entry it found, as many as stated", async () => {
    const { body } = await read("a-post", "?include=related&relatedLimit=2");
    expect(mocks.related).toHaveBeenCalledWith(SITE.id, "en", { contentId: 7, limit: 2 });
    expect(body.related.map((entry: { slug: string }) => entry.slug)).toEqual(["b-post", "c-post"]);
  });

  it("translates the entry and its relatives in one request per context", async () => {
    const { body } = await read("a-post", "?include=related", "de");
    const titleCalls = mocks.translateSite.mock.calls.filter(([input]) => input.ctx === "blog post title");
    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0]![0].msgs).toEqual(["Title a-post", "Title b-post", "Title c-post"]);
    expect(body.related[0].title).toBe("de:Title b-post");
  });

  it("refuses what it cannot answer instead of ignoring it", async () => {
    expect((await read("a-post", "?include=comments")).status).toBe(400);
    for (const limit of ["0", "13", "two"]) {
      expect((await read("a-post", `?include=related&relatedLimit=${limit}`)).status, limit).toBe(400);
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
