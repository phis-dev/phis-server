import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  ensure: vi.fn(async (_siteId: number, msgs: readonly string[], _ctx: string): Promise<Map<string, number | Error>> =>
    new Map(msgs.map((msg, index) => [msg, index + 1]))),
  // Either path as the TR route runs it on recorded messages: held where held, else filled, a never recorded
  // text as written (translations.test.ts, recordedMessages).
  texts: vi.fn(async (input: { locale: string; msgs: string[] }) => input.msgs.map((msg) =>
    (msg === "20 % off" ? "20 % Rabatt" : msg === "" || msg === "never recorded" ? msg : `${input.locale.toUpperCase()} ${msg}`))),
}));
vi.mock("@/db/translations", () => ({
  ensureSiteMessageIds: (...args: [number, readonly string[], string]) => state.ensure(...args),
}));
vi.mock("@/lib/translations", () => ({
  translateSiteTextsWithCache: (input: never) => state.texts(input),
  trackTranslationStandIns: async <T,>(work: () => Promise<T>) => ({ value: await work(), standIn: false }),
}));

import { buildPhisAddonTranslationsCapability } from "./translations-capability.ts";

const capability = (unauthenticated = false, addonSourceLocale: string | null = null) =>
  buildPhisAddonTranslationsCapability({ addonId: "@acme/shop", siteId: 7, siteSourceLocale: "en", addonSourceLocale, unauthenticated });

describe("translations capability", () => {
  it("records under the Add-on's own name in front of its word, skipping empty texts", async () => {
    await capability().record({ context: "listing hint", texts: ["20 % off", "", "  ", "Free shipping"] });
    expect(state.ensure).toHaveBeenCalledWith(7, ["20 % off", "Free shipping"], "@acme/shop: listing hint");
    await capability().record({ context: "listing hint", texts: [""] });
    expect(state.ensure).toHaveBeenCalledTimes(1);
  });

  it("refuses a record from an unverified hook, a context that is not a word of the Add-on's, and too much", async () => {
    await expect(capability(true).record({ context: "listing hint", texts: ["x"] })).rejects.toThrow(/unverified hook/);
    for (const context of ["", " padded", "[html]", "x".repeat(65), "line\nbreak", 7]) {
      await expect(capability().record({ context: context as string, texts: ["x"] }), String(context)).rejects.toThrow(/context/);
    }
    await expect(capability().record({ context: "hint", texts: Array.from({ length: 201 }, () => "x") })).rejects.toThrow(/at most 200/);
    await expect(capability().record({ context: "hint", texts: ["x".repeat(20001)] })).rejects.toThrow(/20000/);
    expect(state.ensure).not.toHaveBeenCalled();
  });

  it("refuses a text that meets another under the same opening", async () => {
    state.ensure.mockResolvedValueOnce(new Map([["clash", new Error("collision")]]));
    await expect(capability().record({ context: "hint", texts: ["clash"] })).rejects.toThrow(/50 characters/);
  });

  it("answers held translations, has the provider fill the rest under the stored context, and keeps the order", async () => {
    const answer = await capability(true).translate({
      context: "listing hint", locale: "de", texts: ["20 % off", "", "Free shipping", "never recorded"],
    });
    expect(answer).toEqual({ texts: ["20 % Rabatt", "", "DE Free shipping", "never recorded"], provisional: false });
    // The TR route's choice, under the stored context, recording nothing and reading the recorded messages.
    expect(state.texts).toHaveBeenCalledWith({
      siteId: 7, locale: "de", sourceLocale: "en", canonicalLocale: "en", ctx: "@acme/shop: listing hint", format: "text",
      create: false, recordedMessages: true,
      msgs: ["20 % off", "", "Free shipping", "never recorded"], storedContexts: Array(4).fill("@acme/shop: listing hint"),
    });
  });

  it("answers the texts as written in the source language, without a locale, and in a language none is kept in", async () => {
    for (const locale of [null, "en", "en-GB", "xx-nowhere"]) {
      expect(await capability().translate({ context: "hint", locale, texts: ["20 % off"] }), String(locale))
        .toEqual({ texts: ["20 % off"], provisional: false });
    }
    expect(state.texts).not.toHaveBeenCalled();
    await expect(capability().translate({ context: "hint", locale: 7 as never, texts: [] })).rejects.toThrow(/locale/);
  });

  it("reads texts in another language than the Site's through the external path, a held translation winning", async () => {
    const answer = await capability().translate({
      context: "listing hint", locale: "de", sourceLocale: "fr", texts: ["20 % off", "Livraison gratuite", "never recorded"],
    });
    expect(answer.texts).toEqual(["20 % Rabatt", "DE Livraison gratuite", "never recorded"]);
    // The external path, a translation held on the recorded message winning there (translations.test.ts).
    expect(state.texts).toHaveBeenCalledWith(expect.objectContaining({
      locale: "de", sourceLocale: "fr", canonicalLocale: "en", ctx: "@acme/shop: listing hint", format: "text",
      msgs: ["20 % off", "Livraison gratuite", "never recorded"], recordedMessages: true,
    }));
    // In their own language they are the answer.
    expect(await capability().translate({ context: "hint", locale: "fr", sourceLocale: "fr", texts: ["Livraison"] })).toEqual({ texts: ["Livraison"], provisional: false });
  });

  it("takes the Add-on's own language where the call names none, the Site's where the manifest names none either", async () => {
    await capability(false, "fr").translate({ context: "hint", locale: "de", texts: ["Livraison gratuite"] });
    expect(state.texts).toHaveBeenCalledWith(expect.objectContaining({ sourceLocale: "fr" }));
    // Stated, the call's language wins over the Add-on's: what staff typed is the Site's.
    await capability(false, "fr").translate({ context: "hint", locale: "de", sourceLocale: "en", texts: ["Free shipping"] });
    expect(state.texts).toHaveBeenCalledWith(expect.objectContaining({ sourceLocale: "en" }));
    expect(await capability(false, "fr").translate({ context: "hint", locale: "fr", texts: ["Livraison"] })).toEqual({ texts: ["Livraison"], provisional: false });
  });

  it("refuses a language Core does not know", async () => {
    await expect(capability().record({ context: "hint", texts: ["x"], sourceLocale: "xx-nowhere" })).rejects.toThrow(/sourceLocale/);
    await expect(capability().translate({ context: "hint", locale: "de", texts: ["x"], sourceLocale: 7 as never })).rejects.toThrow(/sourceLocale/);
    expect(state.ensure).not.toHaveBeenCalled();
  });
});
