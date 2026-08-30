import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSiteMessageId: vi.fn(),
  getSiteTranslations: vi.fn(),
  upsertSiteTranslations: vi.fn(),
  logRuntimeEvent: vi.fn(),
}));

vi.mock("@/db/translations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/translations")>()),
  ensureSiteMessageId: mocks.ensureSiteMessageId,
  getSiteTranslations: mocks.getSiteTranslations,
  upsertSiteTranslations: mocks.upsertSiteTranslations,
}));
vi.mock("@/lib/log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/log")>()),
  logRuntimeEvent: mocks.logRuntimeEvent,
}));

const { translateSiteBatchWithCache } = await import("@/lib/translations");

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
      expect.objectContaining({ meta: expect.objectContaining({ stage: "ensureSiteMessageId" }) }),
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
