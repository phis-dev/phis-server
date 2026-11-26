import { describe, expect, it } from "vitest";

import { isPhiSameWrittenLanguage, resolveSiteLocale, resolveSiteLocaleCapabilities } from "./locale";

/*
 * A Site process answers a request that names its locale from `localeCapabilities` instead of asking
 * `/api/v1/site/locale`. That is only sound while the entry it picks is the one Core would have answered
 * with, whatever the visitor's other preferences say.
 */
describe("a Site's locale capabilities", () => {
  const available = ["de", "pt-BR", "en"];

  it("are what resolveSiteLocale answers for a requested served locale", () => {
    const capabilities = resolveSiteLocaleCapabilities(available);
    expect(capabilities.map((capability) => capability.locale)).toEqual(["de", "pt-BR", "en"]);
    for (const capability of capabilities) {
      const resolved = resolveSiteLocale({
        requestedLocale: capability.locale,
        userPreferredLocale: "en",
        cookieLocale: "de",
        browserLocale: "pt-BR,en;q=0.8",
        defaultLocale: "en",
        availableLocales: available,
      });
      expect(resolved).toEqual({ ...capability, requestedLocale: capability.locale, source: "requested" });
    }
  });
});

/*
 * Whether a message needs translating for a reader: one language whatever the region, but never one
 * language across two scripts, and never "the same" where either side is no locale at all.
 */
describe("the same written language", () => {
  it("is the language and the script, not the region", () => {
    for (const [left, right] of [["de", "de"], ["de", "de-AT"], ["de_CH", "de-DE"], ["en-US", "en-GB"], ["pt", "pt-BR"], ["zh", "zh-Hans"], ["zh-CN", "zh-Hans"], ["no", "nb"]]) {
      expect(isPhiSameWrittenLanguage(left, right)).toBe(true);
    }
  });

  it("differs across languages and across scripts", () => {
    for (const [left, right] of [["de", "en"], ["zh-Hans", "zh-Hant"], ["zh-CN", "zh-TW"], ["pt", "es"]]) {
      expect(isPhiSameWrittenLanguage(left, right)).toBe(false);
    }
  });

  it("is never claimed for an unknown or missing side", () => {
    for (const [left, right] of [[null, "de"], ["de", undefined], ["", ""], ["xx", "xx"]]) {
      expect(isPhiSameWrittenLanguage(left, right)).toBe(false);
    }
  });
});
