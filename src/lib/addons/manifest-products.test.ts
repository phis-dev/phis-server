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

const issuesOf = (products: unknown) => validatePhisAddonManifest(manifest({ products })).issues;

describe("products in a manifest", () => {
  it("admits well-formed products, and a manifest that states none", () => {
    expect(issuesOf([
      { key: "pro", type: "addon", title: "Pro", summary: "" },
      { key: "seats.team-1", type: "plan", title: "Seats", summary: "Per seat", counted: true, free: true },
      { key: "acct", type: "plan", title: "Acct", summary: "", accountRequired: true },
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
    expect(issuesOf([{ ...entry, accountRequired: "yes" }]).join("\n")).toMatch(/accountRequired is a boolean/);
    expect(issuesOf([{ ...entry, counted: "yes" }]).join("\n")).toMatch(/counted is a boolean/);
    expect(issuesOf([{ ...entry, sale: "referral" }]).join("\n")).toMatch(/referralUrl/);
    expect(issuesOf([{ ...entry, counted: true, parts: ["@acme/licenses:x"] }]).join("\n")).toMatch(/not counted/);
    expect(issuesOf([{ ...entry, parts: ["@acme/licenses:pro"] }]).join("\n")).toMatch(/part of itself/);
    expect(issuesOf([{ key: "pro" }]).length).toBeGreaterThan(0);
  });

  it("no longer knows entitlement kinds, which the product replaces", () => {
    // The field is not validated any more; an old manifest's stray field is tolerated like any unknown one.
    expect(validatePhisAddonManifest(manifest({ entitlementKinds: [{ key: "Pro" }] })).issues).toEqual([]);
  });
});
