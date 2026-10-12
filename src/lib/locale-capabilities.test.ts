import { describe, expect, it } from "vitest";

import { resolveSiteLocale, resolveSiteLocaleCapabilities } from "./locale";

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
