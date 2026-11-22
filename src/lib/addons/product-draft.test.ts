import { describe, expect, it } from "vitest";

import { isPhisProductId, isPhisProductKey, normalizePhisProductDraft, splitPhisProductId } from "./product-draft.ts";

const base = { key: "pro", type: "licence", title: "Pro", summary: "One year" };

describe("a product's id and key", () => {
  it("reads the grammar", () => {
    expect(isPhisProductId("@acme/licenses:pro-1y.eu")).toBe(true);
    for (const bad of ["acme/licenses:pro", "@acme:pro", "@acme/licenses", "@acme/licenses:Pro", "@acme/licenses:1pro", 3, null]) {
      expect(isPhisProductId(bad), String(bad)).toBe(false);
    }
    expect(splitPhisProductId("@acme/licenses:pro")).toEqual({ supplier: "@acme/licenses", key: "pro" });
  });

  it("limits a key to 96 characters", () => {
    expect(isPhisProductKey("a".repeat(96))).toBe(true);
    expect(isPhisProductKey("a".repeat(97))).toBe(false);
    expect(isPhisProductId(`@acme/licenses:${"a".repeat(97)}`)).toBe(false);
    expect(isPhisProductKey("Pro")).toBe(false);
    expect(isPhisProductKey("")).toBe(false);
  });
});

describe("a product draft", () => {
  it("fills the defaults in", () => {
    expect(normalizePhisProductDraft(base)).toEqual({
      ...base, publisher: null, imageAssetId: null, iconAssetId: null, counted: false, sale: "own", referralUrl: null, free: false, accountRequired: false, parts: [],
    });
  });

  it("asks a referral for an https address, and keeps no address otherwise", () => {
    expect(() => normalizePhisProductDraft({ ...base, sale: "referral" })).toThrow(/referralUrl/);
    expect(() => normalizePhisProductDraft({ ...base, sale: "referral", referralUrl: "http://acme.example/shop" })).toThrow(/https/);
    expect(() => normalizePhisProductDraft({ ...base, sale: "referral", referralUrl: "not a url" })).toThrow(/https/);
    expect(normalizePhisProductDraft({ ...base, sale: "referral", referralUrl: "https://acme.example/shop" }).referralUrl).toBe("https://acme.example/shop");
    expect(normalizePhisProductDraft({ ...base, sale: "own", referralUrl: "https://acme.example/shop" }).referralUrl).toBeNull();
    expect(normalizePhisProductDraft({ ...base, sale: "payout", referralUrl: "https://acme.example/shop" }).referralUrl).toBeNull();
  });

  it("refuses what a bundle may not be", () => {
    const part = "@acme/licenses:part";
    expect(normalizePhisProductDraft({ ...base, parts: [part] }).parts).toEqual([part]);
    expect(() => normalizePhisProductDraft({ ...base, parts: [part, part] })).toThrow(/twice/);
    expect(() => normalizePhisProductDraft({ ...base, parts: ["part"] as never })).toThrow(/parts/);
    expect(() => normalizePhisProductDraft({ ...base, parts: ["@acme/licenses:pro"] }, "@acme/licenses:pro")).toThrow(/part of itself/);
    expect(() => normalizePhisProductDraft({ ...base, counted: true, parts: [part] })).toThrow(/not counted/);
  });

  it("takes whether an account is required, false when absent", () => {
    expect(normalizePhisProductDraft({ ...base, accountRequired: true }).accountRequired).toBe(true);
    expect(normalizePhisProductDraft({ ...base, accountRequired: false }).accountRequired).toBe(false);
    expect(() => normalizePhisProductDraft({ ...base, accountRequired: "yes" as never })).toThrow(/accountRequired/);
  });

  it("refuses the wrong shapes", () => {
    expect(() => normalizePhisProductDraft({ ...base, key: "Pro" })).toThrow(/key/);
    expect(() => normalizePhisProductDraft({ ...base, sale: "gift" as never })).toThrow(/sale/);
    expect(() => normalizePhisProductDraft({ ...base, title: "" })).toThrow(/title/);
    expect(() => normalizePhisProductDraft({ ...base, type: "x".repeat(65) })).toThrow(/type/);
    expect(() => normalizePhisProductDraft({ ...base, counted: "yes" as never })).toThrow(/counted/);
    expect(() => normalizePhisProductDraft({ ...base, imageAssetId: 0 })).toThrow(/imageAssetId/);
    expect(() => normalizePhisProductDraft({ ...base, iconAssetId: 1.5 })).toThrow(/iconAssetId/);
    expect(() => normalizePhisProductDraft({ ...base, iconAssetId: -2 })).toThrow(/iconAssetId/);
    expect(() => normalizePhisProductDraft({ ...base, publisher: "" })).toThrow(/publisher/);
    expect(normalizePhisProductDraft({ ...base, publisher: "acme", imageAssetId: 4, iconAssetId: 5, summary: "" }))
      .toMatchObject({ publisher: "acme", imageAssetId: 4, iconAssetId: 5, summary: "" });
  });
});
