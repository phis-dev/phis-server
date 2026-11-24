import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  ensure: vi.fn(async (_siteId: number, msgs: readonly string[], _ctx: string): Promise<Map<string, number | Error>> =>
    new Map(msgs.map((msg, index) => [msg, index + 1]))),
  find: vi.fn(async (_siteId: number, msgs: readonly string[], _ctx: string) =>
    new Map(msgs.filter((msg) => msg !== "never recorded").map((msg, index) => [msg, index + 10]))),
  held: vi.fn(async (_ids: number[], _locale: string) => new Map<number, string>([[10, "20 % Rabatt"]])),
  fill: vi.fn(async (input: { messages: { msgId: number; msg: string }[] }) =>
    new Map(input.messages.map((message) => [message.msgId, `DE ${message.msg}`]))),
}));
vi.mock("@/lib/config", () => ({ getPhisConfigSync: () => ({ sites: { overrides: { acme: { sourceLocale: "en" } } } }) }));
vi.mock("@/db/translations", () => ({
  ensureSiteMessageIds: (...args: [number, readonly string[], string]) => state.ensure(...args),
  findSiteMessageIds: (...args: [number, readonly string[], string]) => state.find(...args),
  getSiteTranslations: (...args: [number[], string]) => state.held(...args),
}));
vi.mock("@/lib/translations", () => ({
  fillSiteMessageTranslations: (input: never) => state.fill(input),
  trackTranslationStandIns: async <T,>(work: () => Promise<T>) => ({ value: await work(), standIn: false }),
}));

import { buildPhisAddonTranslationsCapability } from "./translations-capability.ts";

const capability = (unauthenticated = false) =>
  buildPhisAddonTranslationsCapability({ addonId: "@acme/shop", siteId: 7, siteKey: "acme", unauthenticated });

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
    expect(state.find).toHaveBeenCalledWith(7, ["20 % off", "Free shipping", "never recorded"], "@acme/shop: listing hint");
    expect(state.fill).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 7, locale: "de", sourceLocale: "en", providerContext: "@acme/shop: listing hint", messages: [{ msgId: 11, msg: "Free shipping" }],
    }));
  });

  it("answers the texts as written in the source language, without a locale, and in a language none is kept in", async () => {
    for (const locale of [null, "en", "en-GB", "xx-nowhere"]) {
      expect(await capability().translate({ context: "hint", locale, texts: ["20 % off"] }), String(locale))
        .toEqual({ texts: ["20 % off"], provisional: false });
    }
    expect(state.find).not.toHaveBeenCalled();
    await expect(capability().translate({ context: "hint", locale: 7 as never, texts: [] })).rejects.toThrow(/locale/);
  });
});
