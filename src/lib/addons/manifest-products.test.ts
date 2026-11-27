import { describe, expect, it } from "vitest";

import { validatePhisAddonManifest } from "./manifest.ts";

/** The products an Add-on's package carries: the draft a supplier would register, in the manifest. */

function manifest(extra: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    addonId: "@acme/licenses",
    packageName: "@acme/licenses",
    packageVersion: "1.0.0",
    serverAbi: "^1",
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: [],
    apiRoutes: [],
    hooks: [],
    jobs: [],
    schema: null,
    migrationVersion: 0,
    ...extra,
  };
}

const issuesOf = (products: unknown) => validatePhisAddonManifest(manifest({ products, sourceLocale: "en" })).issues;

describe("the language of what a manifest ships", () => {
  const entry = { key: "pro", type: "a", title: "Pro", summary: "" };
  const issues = (extra: Record<string, unknown>) => validatePhisAddonManifest(manifest(extra)).issues.join("\n");

  it("is required with products and with translations:v1, and nowhere else", () => {
    expect(issues({ products: [entry] })).toMatch(/sourceLocale is required/);
    expect(issues({ requiredCoreCapabilities: ["@phis/server/translations:v1"] })).toMatch(/sourceLocale is required/);
    expect(issues({ products: [] })).toBe("");
    expect(issues({ products: [entry], sourceLocale: "fr" })).toBe("");
    expect(issues({ sourceLocale: "pt-BR" })).toBe("");
  });

  it("is a language Core knows, spelled as Core spells it", () => {
    expect(issues({ products: [entry], sourceLocale: "xx-nowhere" })).toMatch(/sourceLocale must be a locale key/);
    expect(issues({ products: [entry], sourceLocale: "FR" })).toMatch(/spelled as Core spells it.*: fr/);
    expect(issues({ products: [entry], sourceLocale: 7 })).toMatch(/sourceLocale must be/);
  });
});

describe("products in a manifest", () => {
  it("admits well-formed products, and a manifest that states none", () => {
    expect(issuesOf([
      { key: "pro", type: "addon", title: "Pro", summary: "" },
      { key: "seats.team-1", type: "plan", title: "Seats", summary: "Per seat", flags: 1 | 4 },
      { key: "acct", type: "plan", title: "Acct", summary: "", flags: 2 },
      { key: "bundle", type: "plan", title: "Bundle", summary: "", parts: ["@acme/licenses:pro"] },
      { key: "ext", type: "addon", title: "Ext", summary: "", sale: "referral", referralUrl: "https://acme.example/ext" },
    ])).toEqual([]);
    expect(validatePhisAddonManifest(manifest()).issues).toEqual([]);
  });

  it("refuses a key outside the grammar, and a duplicate", () => {
    expect(issuesOf([{ key: "Pro", type: "a", title: "Pro", summary: "" }]).join("\n")).toMatch(/products\[0\]: A product key/);
    expect(issuesOf([{ key: "1pro", type: "a", title: "Pro", summary: "" }]).join("\n")).toMatch(/products\[0\]/);
    expect(issuesOf([{ key: "a".repeat(97), type: "a", title: "Pro", summary: "" }]).join("\n")).toMatch(/products\[0\]/);
    expect(issuesOf([{ key: "pro", type: "a", title: "A", summary: "" }, { key: "pro", type: "a", title: "B", summary: "" }]).join("\n")).toMatch(/products contains duplicate "pro"/);
  });

  it("refuses what only a runtime knows, and the wrong types", () => {
    const entry = { key: "pro", type: "a", title: "Pro", summary: "" };
    expect(issuesOf("pro")).toContain("products must be an array when it is stated at all.");
    expect(issuesOf(["pro"])).toContain("products[0] must be an object.");
    expect(issuesOf([{ ...entry, publisher: "acme" }])).toContain("products[0].publisher is not declared in a manifest.");
    expect(issuesOf([{ ...entry, imageAssetId: 3 }])).toContain("products[0].imageAssetId is not declared in a manifest.");
    expect(issuesOf([{ ...entry, iconAssetId: 3 }])).toContain("products[0].iconAssetId is not declared in a manifest.");
    expect(issuesOf([{ ...entry, gallery: [3] }])).toContain("products[0].gallery is not declared in a manifest.");
    // The language is the manifest's, never a product's own.
    expect(issuesOf([{ ...entry, sourceLocale: "fr" }])).toContain("products[0].sourceLocale is not declared in a manifest.");
    // A manifest may state a description, as every other text of the product.
    expect(issuesOf([{ ...entry, description: "## Long" }])).toEqual([]);
    expect(issuesOf([{ ...entry, accountRequired: true }]).join("\n")).toMatch(/accountRequired is no longer read/);
    expect(issuesOf([{ ...entry, flags: "yes" }]).join("\n")).toMatch(/flags carries only/);
    expect(issuesOf([{ ...entry, flags: 16 }]).join("\n")).toMatch(/Supplied and Released are Core's/);
    expect(issuesOf([{ ...entry, sale: "referral" }]).join("\n")).toMatch(/referralUrl/);
    expect(issuesOf([{ ...entry, flags: 1, parts: ["@acme/licenses:x"] }]).join("\n")).toMatch(/not counted/);
    expect(issuesOf([{ ...entry, parts: ["@acme/licenses:pro"] }]).join("\n")).toMatch(/part of itself/);
    expect(issuesOf([{ key: "pro" }]).length).toBeGreaterThan(0);
  });

  it("no longer knows entitlement kinds, which the product replaces", () => {
    // The field is not validated any more; an old manifest's stray field is tolerated like any unknown one.
    expect(validatePhisAddonManifest(manifest({ entitlementKinds: [{ key: "Pro" }] })).issues).toEqual([]);
  });
});
