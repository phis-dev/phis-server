import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSiteMessageId: vi.fn(),
  getSiteTranslations: vi.fn(),
  getTranslations: vi.fn(),
  upsertSiteTranslations: vi.fn(),
  logRuntimeEvent: vi.fn(),
}));

vi.mock("@/db/translations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/translations")>()),
  // The batch answers per message what the single form would: the id, or the Error it would throw.
  ensureSiteMessageIds: async (siteId: number, msgs: readonly string[]) => new Map(await Promise.all(
    msgs.map(async (msg) => {
      try {
        return [msg, await mocks.ensureSiteMessageId(siteId, msg)] as const;
      } catch (error) {
        return [msg, error as Error] as const;
      }
    }),
  )),
  getSiteTranslations: mocks.getSiteTranslations,
  getTranslations: mocks.getTranslations,
  upsertSiteTranslations: mocks.upsertSiteTranslations,
}));
vi.mock("@/lib/log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/log")>()),
  logRuntimeEvent: mocks.logRuntimeEvent,
}));

const { trackTranslationStandIns, translateBatchWithCache, translateSiteBatchWithCache } =
  await import("@/lib/translations");

/*
 * Catalogue identity can genuinely fail for one message: `tr_site_msg` is unique on
 * (site_id, msg_hash, ctx) and the hash covers a prefix, so two messages sharing an opening are one
 * message to it. That failure used to leave the whole batch, and every other string travelling with it
 * fell back to its source language -- a page lost its translations over one paragraph.
 */
describe("translateSiteBatchWithCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSiteTranslations.mockResolvedValue(new Map([[2, "zwei"], [3, "drei"]]));
    mocks.upsertSiteTranslations.mockResolvedValue(undefined);
  });

  it("keeps the rest of a batch when one message cannot be resolved", async () => {
    mocks.ensureSiteMessageId.mockImplementation(async (_siteId: number, msg: string) => {
      if (msg === "one") throw new Error("Hash collision detected for tr_site_msg");
      return msg === "two" ? 2 : 3;
    });

    await expect(translateSiteBatchWithCache({
      siteId: 1,
      locale: "de",
      sourceLocale: "en",
      msgs: ["one", "two", "three"],
      ctx: "",
      format: "text",
    })).resolves.toEqual(["one", "zwei", "drei"]);
  });

  it("reports the message it skipped rather than swallowing it", async () => {
    mocks.ensureSiteMessageId.mockImplementation(async (_siteId: number, msg: string) => {
      if (msg === "one") throw new Error("Hash collision detected for tr_site_msg");
      return 2;
    });

    await translateSiteBatchWithCache({
      siteId: 1,
      locale: "de",
      sourceLocale: "en",
      msgs: ["one", "two"],
      ctx: "",
      format: "text",
    });

    expect(mocks.logRuntimeEvent).toHaveBeenCalledWith(
      "warn",
      "translation.message_skipped",
      expect.objectContaining({ meta: expect.objectContaining({ stage: "ensureSiteMessageIds" }) }),
    );
  });

  it("does not hide a failure that is not about one message", async () => {
    mocks.ensureSiteMessageId.mockImplementation(async (_siteId: number, msg: string) => msg === "two" ? 2 : 3);
    mocks.getSiteTranslations.mockRejectedValue(new Error("connection terminated"));

    await expect(translateSiteBatchWithCache({
      siteId: 1,
      locale: "de",
      sourceLocale: "en",
      msgs: ["two", "three"],
      ctx: "",
      format: "text",
    })).rejects.toThrow("connection terminated");
  });

  it("leaves a batch alone when every message resolves", async () => {
    mocks.ensureSiteMessageId.mockImplementation(async (_siteId: number, msg: string) => msg === "two" ? 2 : 3);

    await expect(translateSiteBatchWithCache({
      siteId: 1,
      locale: "de",
      sourceLocale: "en",
      msgs: ["two", "three"],
      ctx: "",
      format: "text",
    })).resolves.toEqual(["zwei", "drei"]);
    expect(mocks.logRuntimeEvent).not.toHaveBeenCalled();
  });
});

/*
 * `tr_site_lang.locale` is compared as written: `DE` and `de` were two rows, two paid provider calls, and
 * a locale longer than the column failed the write.
 */
describe("the locale a Site translation is stored under", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureSiteMessageId.mockResolvedValue(2);
    mocks.getSiteTranslations.mockResolvedValue(new Map([[2, "zwei"]]));
  });

  it("is the catalog's spelling, however the caller wrote it", async () => {
    for (const locale of ["DE", "de", " de "]) {
      await translateSiteBatchWithCache({
        siteId: 1, locale, sourceLocale: "en", msgs: ["two"], ctx: "", format: "text",
      });
    }
    await translateSiteBatchWithCache({
      siteId: 1, locale: "pt_br", sourceLocale: "EN", msgs: ["two"], ctx: "", format: "text",
    });

    expect(mocks.getSiteTranslations.mock.calls.map((call) => call[1])).toEqual(["de", "de", "de", "pt-BR"]);
  });

  it("refuses a language the catalog does not know", async () => {
    await expect(translateSiteBatchWithCache({
      siteId: 1, locale: "klingon-ext", sourceLocale: "en", msgs: ["two"], ctx: "", format: "text",
    })).rejects.toThrow(/not a supported translation locale/u);
    expect(mocks.getSiteTranslations).not.toHaveBeenCalled();
  });
});

/*
 * A Site keeps translations without expiry. Source text that stands in for a failure must reach it
 * marked, or the Site would keep it until somebody edited a translation.
 */
describe("trackTranslationStandIns", () => {
  const batch = (msgs: string[]) => translateSiteBatchWithCache({
    siteId: 1,
    locale: "de",
    sourceLocale: "en",
    msgs,
    ctx: "",
    format: "text",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSiteTranslations.mockResolvedValue(new Map([[2, "zwei"], [3, "drei"]]));
    mocks.ensureSiteMessageId.mockImplementation(async (_siteId: number, msg: string) => {
      if (msg === "one") throw new Error("Hash collision detected for tr_site_msg");
      return msg === "two" ? 2 : 3;
    });
  });

  it("reports a batch in which a message fell back to its source text", async () => {
    await expect(trackTranslationStandIns(() => batch(["one", "two"]))).resolves.toEqual({
      value: ["one", "zwei"],
      standIn: true,
    });
  });

  it("does not report a batch the store answered in full", async () => {
    await expect(trackTranslationStandIns(() => batch(["two", "three"]))).resolves.toEqual({
      value: ["zwei", "drei"],
      standIn: false,
    });
  });

  it("keeps concurrent requests apart", async () => {
    const [failed, answered] = await Promise.all([
      trackTranslationStandIns(() => batch(["one"])),
      trackTranslationStandIns(() => batch(["two"])),
    ]);
    expect(failed.standIn).toBe(true);
    expect(answered.standIn).toBe(false);
  });
});

/*
 * The global store read by a request that may not fill it, which is what a mirror behind `cdn.phis.dev`
 * answers. A miss there is the one case where source text travels back without anybody having failed,
 * and the installation that asked has DeepL waiting after this step: unmarked, the English string
 * arrives there as the translation and is never translated at all.
 */
describe("a read of the global store that may not write", () => {
  const read = (msgs: string[]) => trackTranslationStandIns(() => translateBatchWithCache({
    locale: "de",
    sourceLocale: "en",
    msgs,
    ctx: "",
    write: "none",
    format: "text",
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    // The store holds every message but "one".
    mocks.getTranslations.mockImplementation(async (
      _locale: string,
      entries: Array<{ msg: string; hash: string }>,
    ) => new Map(
      entries.filter((entry) => entry.msg !== "one").map((entry) => [entry.hash, `${entry.msg}-de`]),
    ));
  });

  it("marks a batch it could not answer in full", async () => {
    await expect(read(["one", "two"])).resolves.toEqual({
      value: ["one", "two-de"],
      standIn: true,
    });
  });

  it("marks nothing in a batch the store held", async () => {
    await expect(read(["two", "three"])).resolves.toEqual({
      value: ["two-de", "three-de"],
      standIn: false,
    });
  });
});
