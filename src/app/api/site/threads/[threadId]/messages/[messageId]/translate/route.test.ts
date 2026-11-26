import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ read: vi.fn(), record: vi.fn(), unit: vi.fn() }));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteAuthenticatedApiContext: async () => ({
    context: { site: { id: 1, key: "acme" }, session: { userId: 7 } },
    error: null,
  }),
}));
vi.mock("@/db/sites", () => ({ readSiteAvailableLocales: async () => ["de", "en", "zh-Hans", "zh-Hant", "pt-BR"] }));
vi.mock("@/lib/translation-offer", () => ({
  resolvePhisTranslationOffer: async () => ({ available: true, targetLocales: ["de", "en", "zh-Hans", "zh-Hant", "pt-BR"] }),
}));
vi.mock("@/db/threads", () => ({
  readThreadMessageForTranslation: mocks.read,
  recordDetectedThreadMessageSourceLang: mocks.record,
}));
vi.mock("@/lib/translation-unit", () => ({ requestPhisTranslationUnit: mocks.unit }));

import { POST } from "./route";

function translate(locale: string) {
  return POST(
    new NextRequest("https://server.test/api/site/threads/5/messages/9/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale }),
    }),
    { params: Promise.resolve({ threadId: "5", messageId: "9" }) },
  );
}

function message(sourceLang: string | null) {
  return { messageId: 9, flags: 0, body: "Hallo, wie geht es?", sourceLang };
}

/**
 * A message already in the language asked for is answered with itself, and the provider is not paid to
 * say so; one in another language, or in none anybody knows, is still the provider's.
 */
describe("translating one message", () => {
  beforeEach(() => {
    mocks.record.mockResolvedValue(true);
    mocks.unit.mockResolvedValue({
      succeeded: true,
      translations: ["Hello, how are you?"],
      detectedSourceLocales: ["de"],
    });
  });

  it("answers with the original where the known language reads as the target", async () => {
    for (const [sourceLang, target] of [["de", "de"], ["de-AT", "de"], ["en-US", "en"], ["pt", "pt-BR"], ["zh-Hans", "zh-Hans"]]) {
      mocks.read.mockResolvedValue(message(sourceLang));
      const response = await translate(target);
      expect(response.status).toBe(200);
      expect((await response.json()).translation).toEqual({
        messageId: 9,
        targetLocale: target,
        sourceLocale: sourceLang,
        text: "Hallo, wie geht es?",
      });
    }
    expect(mocks.unit).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("asks the provider where the known language is another one, a script included", async () => {
    for (const [sourceLang, target] of [["de", "en"], ["zh-Hant", "zh-Hans"]]) {
      mocks.unit.mockClear();
      mocks.read.mockResolvedValue(message(sourceLang));
      const response = await translate(target);
      expect(response.status).toBe(200);
      expect((await response.json()).translation.text).toBe("Hello, how are you?");
      expect(mocks.unit).toHaveBeenCalledWith(expect.objectContaining({ locale: target, sourceLocale: sourceLang }));
    }
    // A declared language is not replaced by what the provider recognised.
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("leaves an unknown language to the provider and keeps what it recognised", async () => {
    mocks.read.mockResolvedValue(message(null));
    const response = await translate("de");
    expect(response.status).toBe(200);
    expect(mocks.unit).toHaveBeenCalledWith(expect.objectContaining({ locale: "de", sourceLocale: null }));
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ messageId: 9, locale: "de" }));
  });
});
