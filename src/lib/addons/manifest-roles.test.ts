import { describe, expect, it } from "vitest";

import { validatePhiServerAddonManifest } from "./manifest.ts";

/**
 * What an Add-on may declare about its own roles.
 *
 * The names are the Add-on's vocabulary and Core never interprets them. What Core does check is that the
 * policy beside each name is one it can evaluate: a Site access it knows, or a role this same Add-on
 * declares. A policy pointing at something Core cannot resolve would be a rule that silently never holds.
 */

function manifest(extra: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    addonId: "@acme/market",
    packageName: "@acme/market",
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

const admin = { name: "market-admin", grantableBy: { siteAccess: "site-admin" } };
const vendor = { name: "vendor", grantableBy: { role: "market-admin" } };

function issuesFor(roles: unknown) {
  return validatePhiServerAddonManifest(manifest({ roles })).issues.join("\n");
}

describe("declaring Add-on roles", () => {
  it("accepts a manifest that declares none, as every older one does", () => {
    expect(validatePhiServerAddonManifest(manifest()).issues).toEqual([]);
  });

  it("accepts a role granted by a Site access, and one granted by another role", () => {
    expect(validatePhiServerAddonManifest(manifest({ roles: [admin, vendor] })).issues).toEqual([]);
  });

  it("refuses a policy naming a Site access Core does not have", () => {
    expect(issuesFor([{ name: "vendor", grantableBy: { siteAccess: "postmaster" } }]))
      .toMatch(/grantableBy.siteAccess is not a Site access/);
  });

  it("refuses a policy naming a role this Add-on does not declare", () => {
    expect(issuesFor([admin, { name: "vendor", grantableBy: { role: "someone-elses-admin" } }]))
      .toMatch(/does not name a role this Add-on declares/);
  });

  it("refuses a policy that states both sources, or neither", () => {
    expect(issuesFor([{ name: "vendor", grantableBy: { siteAccess: "site-admin", role: "x" } }]))
      .toMatch(/states either siteAccess or role, and not both/);
    expect(issuesFor([{ name: "vendor", grantableBy: {} }]))
      .toMatch(/states either siteAccess or role, and not both/);
  });

  it("refuses a set nobody can enter", () => {
    // Each grants the other, so the first holder could only have been appointed by a holder. The Site
    // Admin floor means this is survivable at runtime; it is still never what the author meant.
    expect(issuesFor([
      { name: "a", grantableBy: { role: "b" } },
      { name: "b", grantableBy: { role: "a" } },
    ])).toMatch(/roles form a cycle/);
  });

  it("refuses two roles under one name", () => {
    expect(issuesFor([admin, { ...admin, description: "again" }])).toMatch(/roles/);
  });

  it("refuses a name that is not a name", () => {
    expect(issuesFor([{ name: "Market Admin", grantableBy: { siteAccess: "site-admin" } }]))
      .toMatch(/roles\[0\]\.name is invalid/);
  });
});

/**
 * What an Add-on may declare about the groups it needs.
 *
 * It states which ones and Core creates them per Site, because a group exists only inside a Site and an
 * Add-on has no Site until one asks for it. The shape is checked against what `phis.site_groups` will
 * accept, so a manifest that cannot produce its groups is refused at install rather than on the first
 * Site that enables it.
 */
describe("declaring Add-on groups", () => {
  function groupIssues(groups: unknown) {
    return validatePhiServerAddonManifest(manifest({ groups })).issues.join("\n");
  }

  it("accepts a group with a key and a name", () => {
    expect(groupIssues([{ key: "market", name: "Marketplace" }])).toBe("");
  });

  it("accepts a manifest that declares none, because that is what most say", () => {
    expect(groupIssues(undefined)).toBe("");
  });

  it("refuses a key the Site group table would refuse", () => {
    expect(groupIssues([{ key: "Market Place", name: "x" }])).toMatch(/groups\[0\]\.key is invalid/);
    expect(groupIssues([{ key: "-lead", name: "x" }])).toMatch(/groups\[0\]\.key is invalid/);
  });

  it("refuses a group without a name, since that is what an administrator reads", () => {
    expect(groupIssues([{ key: "market", name: "  " }])).toMatch(/must be a non-empty string/);
  });

  it("refuses the same key twice", () => {
    expect(groupIssues([{ key: "market", name: "A" }, { key: "market", name: "B" }]))
      .toMatch(/groups/);
  });
});

/**
 * What an Add-on says about its other half.
 *
 * The one thing Core cannot see from an artifact: whether a Module half exists at all. It is what lets
 * enabling an Add-on for a Site check that the Site has both halves, and an Add-on that is only an
 * Add-on says nothing here.
 */
describe("declaring the Module half", () => {
  function moduleIssues(modules: unknown) {
    return validatePhiServerAddonManifest(manifest({ modules })).issues.join("\n");
  }

  it("accepts ids under this package's own name", () => {
    expect(moduleIssues(["@acme/market/modules/catalogue"])).toBe("");
  });

  it("accepts an Add-on that has no Module half, which is most of them", () => {
    expect(moduleIssues(undefined)).toBe("");
  });

  it("refuses an id belonging to another package", () => {
    expect(moduleIssues(["@other/thing/modules/x"])).toMatch(/must begin with "@acme\/market\/"/);
  });

  it("refuses the same Module twice", () => {
    expect(moduleIssues(["@acme/market/modules/a", "@acme/market/modules/a"])).toMatch(/modules/);
  });
});
