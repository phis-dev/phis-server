import { describe, expect, it } from "vitest";

import { parsePhiAcceptLanguage, resolveRequestLocale, resolveSiteLocale } from "./locale";

/**
 * What a browser's language list decides. Read as one opaque first entry, `de;q=0.9` never matched and
 * a German-only Site answered a German reader in its default.
 */
describe("Accept-Language", () => {
  it("is read as every language it names, most wanted first", () => {
    expect(parsePhiAcceptLanguage("fr-CH, de;q=0.9, en;q=0.8, *;q=0.1")).toEqual(["fr-CH", "de", "en"]);
    expect(parsePhiAcceptLanguage("en;q=0.5, de")).toEqual(["de", "en"]);
    expect(parsePhiAcceptLanguage("de;q=0, fr")).toEqual(["fr"]);
    expect(parsePhiAcceptLanguage(null)).toEqual([]);
  });

  it("finds the first language the Site offers, not only the first one asked for", () => {
    const resolved = resolveSiteLocale({
      browserLocale: "fr-CH, de;q=0.9",
      defaultLocale: "en",
      availableLocales: ["en", "de"],
    });
    expect(resolved.locale).toBe("de");
    expect(resolved.source).toBe("browser");
  });

  it("leaves the weight out of the request locale", () => {
    const headers = new Headers({ "accept-language": "xx;q=1, de;q=0.9" });
    expect(resolveRequestLocale(headers)).toBe("de");
  });
});
