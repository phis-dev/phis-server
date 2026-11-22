import { describe, expect, it } from "vitest";

import { validatePhisAddonManifest } from "./manifest.ts";
import {
  expandPhisAddonHeldRoles,
  findPhisAddonRoleInclusionCycle,
  listPhisAddonRolesHeldThroughSiteAccess,
  listPhisAddonRolesImpliedBySiteAccess,
  listPhisAddonRolesImplying,
  resolvePhisAddonHeldRoles,
} from "./role-inclusion.ts";

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

describe("the roles whose holder holds a given one", () => {
  it("is the role itself and everything that includes it, followed through", () => {
    expect(listPhisAddonRolesImplying(declared, "clerk")).toEqual(["owner", "manager", "clerk"]);
    expect(listPhisAddonRolesImplying(declared, "manager")).toEqual(["owner", "manager"]);
    expect(listPhisAddonRolesImplying(declared, "auditor")).toEqual(["auditor"]);
  });

  it("is empty for a role nobody declared", () => {
    expect(listPhisAddonRolesImplying(declared, "nonesuch")).toEqual([]);
  });
});

/** Who holds which Site access, as `phisSiteAccessHolderOf` answers it from a snapshot. */
const holding = (...accesses: string[]) => (access: string) => accesses.includes(access);
const siteAdmin = holding("site-admin");
const nobody = holding();

describe("what a Site Admin holds", () => {
  it("is every declared role with nothing stored, in declaration order", () => {
    expect(resolvePhisAddonHeldRoles(declared, [], siteAdmin)).toEqual(["owner", "manager", "clerk", "auditor"]);
    // Stored names, declared or not, change nothing for an admin.
    expect(resolvePhisAddonHeldRoles(declared, ["retired"], siteAdmin)).toEqual(["owner", "manager", "clerk", "auditor"]);
  });

  it("leaves everybody else with the granted roles and what they include", () => {
    expect(resolvePhisAddonHeldRoles(declared, ["manager"], nobody)).toEqual(["manager", "clerk"]);
    expect(resolvePhisAddonHeldRoles(declared, [], nobody)).toEqual([]);
  });
});

/**
 * A role that hangs on a Site access: whoever holds the access holds the role, and what it includes, as
 * from a grant -- without one stored, and only for as long as they hold the access.
 */
describe("a role implied by a Site access", () => {
  const books = { name: "books", grantableBy: { siteAccess: "site-admin" as const }, impliedBy: { siteAccess: "accounting" as const }, includes: ["clerk"] };
  const helpdesk = { name: "helpdesk", grantableBy: { siteAccess: "site-admin" as const }, impliedBy: { siteAccess: "support" as const } };
  const withImplied = [books, helpdesk, manager, clerk, auditor];

  it("is held by a holder of the access, with what it includes, and by nobody else", () => {
    expect(listPhisAddonRolesImpliedBySiteAccess(withImplied, holding("accounting"))).toEqual(["books"]);
    expect(resolvePhisAddonHeldRoles(withImplied, [], holding("accounting"))).toEqual(["books", "clerk"]);
    expect(resolvePhisAddonHeldRoles(withImplied, [], holding("support", "accounting"))).toEqual(["books", "helpdesk", "clerk"]);
    expect(resolvePhisAddonHeldRoles(withImplied, [], holding("publishing"))).toEqual([]);
  });

  it("only widens: what is granted stays held beside it", () => {
    expect(resolvePhisAddonHeldRoles(withImplied, ["manager", "auditor"], holding("support")))
      .toEqual(["helpdesk", "manager", "clerk", "auditor"]);
  });

  it("goes with the access: the same grants without it hold only what they did", () => {
    expect(resolvePhisAddonHeldRoles(withImplied, ["auditor"], nobody)).toEqual(["auditor"]);
  });

  it("follows inclusions into an implied role from above, and never upwards from it", () => {
    // `clerk` is implied through `books`; `manager` includes `clerk` but nothing implies `manager`.
    expect(resolvePhisAddonHeldRoles(withImplied, [], holding("accounting"))).not.toContain("manager");
  });

  it("is the roles the user list counts among the holders of the included one", () => {
    expect(listPhisAddonRolesImplying(withImplied, "clerk")).toEqual(["books", "manager", "clerk"]);
  });
  it("is shown beside the grants with the access it hangs on, followed through what it includes", () => {
    expect(listPhisAddonRolesHeldThroughSiteAccess(withImplied, holding("accounting"))).toEqual([
      { role: "books", through: { siteAccess: "accounting" } },
      { role: "clerk", through: { siteAccess: "accounting" } },
    ]);
    expect(listPhisAddonRolesHeldThroughSiteAccess(withImplied, holding("publishing"))).toEqual([]);
  });

  it("names a role's own access before one that reaches it through an inclusion", () => {
    const support = { name: "support-desk", grantableBy: { siteAccess: "site-admin" as const }, impliedBy: { siteAccess: "support" as const }, includes: ["books"] };
    expect(listPhisAddonRolesHeldThroughSiteAccess([support, books, clerk], holding("support", "accounting"))).toEqual([
      { role: "support-desk", through: { siteAccess: "support" } },
      { role: "books", through: { siteAccess: "accounting" } },
      { role: "clerk", through: { siteAccess: "support" } },
    ]);
  });

  it("is empty for a Site Admin, who is shown as holding every role", () => {
    expect(listPhisAddonRolesHeldThroughSiteAccess(withImplied, holding("site-admin", "accounting"))).toEqual([]);
  });
});
