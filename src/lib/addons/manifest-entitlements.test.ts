import { describe, expect, it } from "vitest";

import { validatePhisAddonManifest } from "./manifest.ts";

/** The kinds an Add-on declares: a key in the kind grammar, a title, and whether the kind counts. */

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

const issuesOf = (entitlementKinds: unknown) => validatePhisAddonManifest(manifest({ entitlementKinds })).issues;

describe("entitlement kinds in a manifest", () => {
  it("admits well-formed kinds, and a manifest that states none", () => {
    expect(issuesOf([{ key: "pro", title: "Pro" }, { key: "seats.team-1", title: "Seats", description: "Per seat", counted: true }])).toEqual([]);
    expect(validatePhisAddonManifest(manifest()).issues).toEqual([]);
  });

  it("refuses a key outside the grammar", () => {
    expect(issuesOf([{ key: "Pro", title: "Pro" }])).toContain("entitlementKinds[0].key is invalid.");
    expect(issuesOf([{ key: "1pro", title: "Pro" }])).toContain("entitlementKinds[0].key is invalid.");
    expect(issuesOf([{ key: "pro:x", title: "Pro" }])).toContain("entitlementKinds[0].key is invalid.");
  });

  it("refuses a duplicate key", () => {
    expect(issuesOf([{ key: "pro", title: "A" }, { key: "pro", title: "B" }]).join("\n")).toMatch(/entitlementKinds/);
  });

  it("refuses the wrong types", () => {
    expect(issuesOf("pro")).toContain("entitlementKinds must be an array when it is stated at all.");
    expect(issuesOf(["pro"])).toContain("entitlementKinds[0] must be an object.");
    expect(issuesOf([{ key: "pro", title: "Pro", counted: "yes" }])).toContain("entitlementKinds[0].counted must be a boolean when it is stated at all.");
    expect(issuesOf([{ key: "pro", title: "Pro", description: 3 }])).toContain("entitlementKinds[0].description must be a string when it is stated at all.");
    expect(issuesOf([{ key: "pro" }]).length).toBeGreaterThan(0);
  });
});
