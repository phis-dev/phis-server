import { describe, expect, it } from "vitest";

import {
  filterSiteTranslationTargetLocales,
  resolveSiteLocale,
} from "../src/lib/locale.ts";

describe("Site locale resolution", () => {
  it("uses the Site default only after request, user, cookie, and browser candidates", () => {
    expect(resolveSiteLocale({
      requestedLocale: "it",
      userPreferredLocale: "fr",
      cookieLocale: "de",
      browserLocale: "es",
      defaultLocale: "en",
      availableLocales: ["en", "de", "es"],
    })).toMatchObject({ locale: "de", source: "cookie" });

    expect(resolveSiteLocale({
      requestedLocale: "it",
      userPreferredLocale: "fr",
      cookieLocale: "pt",
      browserLocale: "es",
      defaultLocale: "en",
      availableLocales: ["en", "de", "es"],
    })).toMatchObject({ locale: "es", source: "browser" });

    expect(resolveSiteLocale({
      requestedLocale: "it",
      userPreferredLocale: "fr",
      cookieLocale: "pt",
      browserLocale: "ja",
      defaultLocale: "de",
      availableLocales: ["en", "de", "es"],
    })).toMatchObject({ locale: "de", source: "default" });
  });

  it("excludes the immutable source locale from string and option targets", () => {
    expect(filterSiteTranslationTargetLocales("en", ["en", "de", "fr"]))
      .toEqual(["de", "fr"]);
    expect(filterSiteTranslationTargetLocales("EN-us", [
      { code: "en-US", label: "English" },
      { code: "de", label: "Deutsch" },
    ])).toEqual([{ code: "de", label: "Deutsch" }]);
  });

});
