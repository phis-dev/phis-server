import { describe, expect, it } from "vitest";

import { PHIS_CORE_CAPABILITIES } from "@phis/contracts/addon";

import { validatePhisAddonManifest } from "./manifest.ts";

/** What an Add-on reads of a person through users:v1, which Core holds every road to. */

function manifest(extra: Record<string, unknown> = {}, required: string[] = [PHIS_CORE_CAPABILITIES.users]) {
  return {
    manifestVersion: 1,
    addonId: "@acme/crm",
    packageName: "@acme/crm",
    packageVersion: "1.0.0",
    serverAbi: "^1",
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: required,
    apiRoutes: [],
    hooks: [],
    jobs: [],
    schema: null,
    migrationVersion: 0,
    ...extra,
  };
}

const issuesOf = (users: unknown, required?: string[]) =>
  validatePhisAddonManifest(manifest(users === undefined ? {} : { users }, required)).issues;

describe("users in a manifest", () => {
  it("admits the fields, a background part of them, and none in the background", () => {
    expect(issuesOf({ fields: ["name", "email", "phone", "address"], background: ["name", "address"] })).toEqual([]);
    expect(issuesOf({ fields: ["name"] })).toEqual([]);
    expect(issuesOf({ fields: ["name"], background: [] })).toEqual([]);
    expect(issuesOf(undefined, [])).toEqual([]);
  });

  it("is stated with users:v1 and only with it", () => {
    expect(issuesOf(undefined)).toEqual([`users must be stated with ${PHIS_CORE_CAPABILITIES.users}: the fields this Add-on reads of a person.`]);
    expect(issuesOf({ fields: ["name"] }, [])).toEqual([`users is stated without requiring ${PHIS_CORE_CAPABILITIES.users}.`]);
  });

  it("refuses a field the contract does not name, an empty or duplicate list, and a key it does not state", () => {
    expect(issuesOf({ fields: ["name", "birthday"] }).join("\n")).toMatch(/users\.fields\[1\] must be one of name, email, phone, address/u);
    expect(issuesOf({ fields: [] }).join("\n")).toMatch(/users\.fields must be a non-empty array/u);
    expect(issuesOf({ fields: "name" }).join("\n")).toMatch(/users\.fields must be a non-empty array/u);
    expect(issuesOf({}).join("\n")).toMatch(/users\.fields must be a non-empty array/u);
    expect(issuesOf({ fields: ["name", "name"] })).toContain('users.fields contains duplicate "name".');
    expect(issuesOf({ fields: ["name"], background: ["birthday"] }).join("\n")).toMatch(/users\.background\[0\] must be one of/u);
    expect(issuesOf({ fields: ["name"], background: "name" }).join("\n")).toMatch(/users\.background must be an array/u);
    expect(issuesOf({ fields: ["name"], audit: true }).join("\n")).toMatch(/users\.audit is not part of users/u);
    expect(issuesOf([])).toContain("users must be an object when it is stated at all.");
  });

  it("keeps the background a part of the fields", () => {
    expect(issuesOf({ fields: ["name"], background: ["name", "address"] }))
      .toEqual(["users.background names address, which users.fields does not list."]);
  });
});
