import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ accesses: [] as string[], snapshot: vi.fn(), stored: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/server-addon-roles.mts", () => ({ readPhisAddonUserRoles: mocks.stored }));
// One read of the actor's authorization snapshot, answering every access question asked of it.
vi.mock("./site-access.ts", () => ({
  readPhisSiteAccessHolder: async (...args: unknown[]) => {
    mocks.snapshot(...args);
    return (access: string) => mocks.accesses.includes(access);
  },
}));

import { buildPhisAddonRolesCapability } from "./roles-capability.ts";

const declared = [
  { name: "manager", grantableBy: { siteAccess: "site-admin" as const }, includes: ["clerk"] },
  { name: "clerk", grantableBy: { role: "manager" } },
  { name: "auditor", grantableBy: { siteAccess: "site-admin" as const } },
  { name: "bookkeeper", grantableBy: { siteAccess: "site-admin" as const }, impliedBy: { siteAccess: "accounting" as const }, includes: ["clerk"] },
];

const capability = (actorUserId: number | null) =>
  buildPhisAddonRolesCapability({ addonId: "@acme/shop", siteId: 7, actorUserId, declared });

/** A Site Admin holds every declared role; nobody else holds more than was stored. */
describe("roles:v1 for a Site Admin", () => {
  beforeEach(() => {
    mocks.accesses = [];
    mocks.snapshot.mockReset();
    mocks.stored.mockReset().mockResolvedValue([]);
  });

  it("holds every declared role with nothing stored, and answers no for an undeclared one", async () => {
    mocks.accesses = ["site-admin"];
    const roles = capability(41);
    expect(await roles.has("auditor")).toBe(true);
    expect(await roles.has("clerk")).toBe(true);
    expect(await roles.has("invented")).toBe(false);
    expect(await roles.all()).toEqual(["manager", "clerk", "auditor", "bookkeeper"]);
    expect(mocks.stored).not.toHaveBeenCalled();
    expect(mocks.snapshot).toHaveBeenCalledWith(7, 41);
  });

  it("leaves somebody who is not Site Admin with the stored roles and what they include", async () => {
    mocks.stored.mockResolvedValue(["manager"]);
    const roles = capability(41);
    expect(await roles.all()).toEqual(["manager", "clerk"]);
    expect(await roles.has("auditor")).toBe(false);
  });

  it("still answers no without an actor", async () => {
    mocks.accesses = ["site-admin"];
    expect(await capability(null).has("manager")).toBe(false);
    expect(await capability(null).all()).toEqual([]);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});

/** A role hung on a Site access: held by its holders, answered from the one snapshot of the request. */
describe("roles:v1 for a holder of a Site access a role is implied by", () => {
  beforeEach(() => {
    mocks.accesses = ["accounting"];
    mocks.snapshot.mockReset();
    mocks.stored.mockReset().mockResolvedValue([]);
  });

  it("holds the implied role and what it includes, with nothing stored", async () => {
    const roles = capability(41);
    expect(await roles.has("bookkeeper")).toBe(true);
    expect(await roles.has("clerk")).toBe(true);
    expect(await roles.has("manager")).toBe(false);
    expect(await roles.all()).toEqual(["clerk", "bookkeeper"]);
  });

  it("reads the authorization snapshot once however often has() is asked", async () => {
    const roles = capability(41);
    await roles.has("bookkeeper");
    await roles.has("clerk");
    await roles.all();
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
  });

  it("takes the snapshot the caller hands in instead of reading one", async () => {
    const roles = buildPhisAddonRolesCapability({
      addonId: "@acme/shop",
      siteId: 7,
      actorUserId: 41,
      declared,
      readSiteAccess: async () => (access) => access === "accounting",
    });
    expect(await roles.has("bookkeeper")).toBe(true);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("loses the role with the access, and keeps what is stored", async () => {
    mocks.accesses = ["support"];
    mocks.stored.mockResolvedValue(["auditor"]);
    expect(await capability(41).all()).toEqual(["auditor"]);
  });
});
