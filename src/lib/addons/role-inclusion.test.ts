import { describe, expect, it } from "vitest";

import { validatePhisAddonManifest } from "./manifest.ts";
import { expandPhisAddonHeldRoles, findPhisAddonRoleInclusionCycle } from "./role-inclusion.ts";

/**
 * A role that includes another: holding the upper rung answers yes for the lower ones, followed
 * through, within one Add-on, and never as a grant of its own.
 */

const owner = { name: "owner", grantableBy: { siteAccess: "site-admin" as const }, includes: ["manager"] };
const manager = { name: "manager", grantableBy: { role: "owner" }, includes: ["clerk"] };
const clerk = { name: "clerk", grantableBy: { role: "manager" } };
const auditor = { name: "auditor", grantableBy: { siteAccess: "site-admin" as const } };
const declared = [owner, manager, clerk, auditor];

function manifest(roles: unknown) {
  return {
    manifestVersion: 1,
    addonId: "@acme/shop",
    packageName: "@acme/shop",
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
    roles,
  };
}

describe("held roles", () => {
  it("adds what a granted role includes, transitively, in declaration order", () => {
    expect(expandPhisAddonHeldRoles(declared, ["owner"])).toEqual(["owner", "manager", "clerk"]);
    expect(expandPhisAddonHeldRoles(declared, ["manager"])).toEqual(["manager", "clerk"]);
    expect(expandPhisAddonHeldRoles(declared, ["clerk", "auditor"])).toEqual(["clerk", "auditor"]);
  });

  it("never implies upwards", () => {
    expect(expandPhisAddonHeldRoles(declared, ["clerk"])).toEqual(["clerk"]);
  });

  it("opens nothing for a grant the current manifest does not declare", () => {
    expect(expandPhisAddonHeldRoles([manager, clerk], ["owner"])).toEqual([]);
  });

  it("is the stored grants alone when no role includes another", () => {
    expect(expandPhisAddonHeldRoles([clerk, auditor], ["auditor"])).toEqual(["auditor"]);
  });
});

describe("declaring inclusions", () => {
  it("accepts a ladder", () => {
    expect(validatePhisAddonManifest(manifest(declared)).issues).toEqual([]);
  });

  it("refuses an inclusion naming a role this Add-on does not declare", () => {
    expect(validatePhisAddonManifest(manifest([{ ...auditor, includes: ["reviewer"] }])).issues.join("\n"))
      .toMatch(/includes names "reviewer", which is not a role this Add-on declares/);
  });

  it("refuses a role including itself", () => {
    expect(validatePhisAddonManifest(manifest([{ ...auditor, includes: ["auditor"] }])).issues.join("\n"))
      .toMatch(/includes names the role itself/);
  });

  it("refuses inclusions in a cycle", () => {
    const issues = validatePhisAddonManifest(manifest([owner, manager, { ...clerk, includes: ["owner"] }])).issues.join("\n");
    expect(issues).toMatch(/roles include each other in a cycle/);
    expect(findPhisAddonRoleInclusionCycle([owner, manager, { ...clerk, includes: ["owner"] }]))
      .toEqual(["owner", "manager", "clerk", "owner"]);
  });

  it("refuses includes that is not a list of names", () => {
    expect(validatePhisAddonManifest(manifest([{ ...auditor, includes: "clerk" }])).issues.join("\n"))
      .toMatch(/includes must be an array of role names/);
  });
});
