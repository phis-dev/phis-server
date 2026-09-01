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
