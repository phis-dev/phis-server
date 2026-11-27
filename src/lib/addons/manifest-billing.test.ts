import { describe, expect, it } from "vitest";

import { PHIS_CORE_CAPABILITIES } from "@phis/contracts/addon";

import { validatePhisAddonManifest } from "./manifest.ts";

/** What an Add-on does with billing documents (`billing:v1`), as its manifest says it. */

function manifest(billing: unknown, required: string[] = [PHIS_CORE_CAPABILITIES.billing]) {
  return {
    manifestVersion: 1, addonId: "@acme/invoices", packageName: "@acme/invoices", packageVersion: "1.0.0", serverAbi: "^1",
    capabilities: [], serviceProviders: [], requiredCoreCapabilities: required, apiRoutes: [], hooks: [], jobs: [], schema: null, migrationVersion: 0,
    ...(billing === undefined ? {} : { billing }),
  };
}
const issuesOf = (billing: unknown, required?: string[]) => validatePhisAddonManifest(manifest(billing, required)).issues;

describe("billing in a manifest", () => {
  it("admits the kinds it issues with the capability, and who issues for its sales", () => {
    expect(issuesOf(undefined)).toEqual([]);
    expect(issuesOf({ issues: ["invoice", "credit-note", "reminder"] })).toEqual([]);
    expect(issuesOf({ issuedBy: ["@phis/invoices"] }, [])).toEqual([]);
    expect(issuesOf({ issues: [], issuedBy: [] }, [])).toEqual([]);
  });

  it("refuses issuing without billing:v1, unknown kinds and keys, bad ids and itself", () => {
    expect(issuesOf({ issues: ["invoice"] }, []).join()).toMatch(/without requiring/u);
    expect(issuesOf({ issues: ["bill"] }).join()).toMatch(/billing.issues/u);
    expect(issuesOf({ issues: ["invoice", "invoice"] }).length).toBeGreaterThan(0);
    expect(issuesOf({ issuedBy: ["not-an-id"] }).join()).toMatch(/issuedBy/u);
    expect(issuesOf({ issuedBy: ["@acme/invoices"] }).join()).toMatch(/issuedBy/u);
    expect(issuesOf({ series: [] }).join()).toMatch(/billing.series/u);
    expect(issuesOf("yes").join()).toMatch(/billing must be an object/u);
  });
});
