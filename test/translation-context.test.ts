import { describe, expect, it } from "vitest";

import {
  buildTranslationContext,
  getProviderTranslationContext,
  hasTranslationContextFlag,
  parseTranslationContext,
} from "../src/lib/translation-context";

describe("translation context flags", () => {
  it("stores registered flags in canonical order", () => {
    expect(buildTranslationContext({
      context: "Product description",
      flags: ["extern", "html"],
    })).toBe("[html:extern]Product description");
  });

  it("removes only the leading flag envelope for provider context", () => {
    expect(getProviderTranslationContext("[html:extern]Text shown in [brackets]"))
      .toBe("Text shown in [brackets]");
    expect(parseTranslationContext("Text shown in [brackets]").flags).toEqual([]);
  });

  it("rejects unknown and duplicate flags", () => {
    expect(() => parseTranslationContext("[src:de]Context")).toThrow("Unknown");
    expect(() => parseTranslationContext("[html:html]Context")).toThrow("Duplicate");
  });

  it("exposes protected external and HTML markers", () => {
    const context = buildTranslationContext({ flags: ["html", "extern"] });
    expect(hasTranslationContextFlag(context, "html")).toBe(true);
    expect(hasTranslationContextFlag(context, "extern")).toBe(true);
    expect(getProviderTranslationContext(context)).toBeUndefined();
  });
});
