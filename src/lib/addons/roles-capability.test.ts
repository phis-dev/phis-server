import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), stored: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/server-addon-roles.mts", () => ({ readPhisAddonUserRoles: mocks.stored }));
vi.mock("./site-access.ts", () => ({ holdsPhisSiteAccess: mocks.admin }));

import { buildPhisAddonRolesCapability } from "./roles-capability.ts";

const declared = [
  { name: "manager", grantableBy: { siteAccess: "site-admin" as const }, includes: ["clerk"] },
  { name: "clerk", grantableBy: { role: "manager" } },
  { name: "auditor", grantableBy: { siteAccess: "site-admin" as const } },
];

const capability = (actorUserId: number | null) =>
  buildPhisAddonRolesCapability({ addonId: "@acme/shop", siteId: 7, actorUserId, declared });

/** A Site Admin holds every declared role; nobody else holds more than was stored. */
describe("roles:v1 for a Site Admin", () => {
  beforeEach(() => {
    mocks.admin.mockReset().mockResolvedValue(false);
    mocks.stored.mockReset().mockResolvedValue([]);
  });

  it("holds every declared role with nothing stored, and answers no for an undeclared one", async () => {
    mocks.admin.mockResolvedValue(true);
    const roles = capability(41);
    expect(await roles.has("auditor")).toBe(true);
    expect(await roles.has("clerk")).toBe(true);
    expect(await roles.has("invented")).toBe(false);
    expect(await roles.all()).toEqual(["manager", "clerk", "auditor"]);
    expect(mocks.stored).not.toHaveBeenCalled();
    expect(mocks.admin).toHaveBeenCalledWith(7, 41, "site-admin");
  });

  it("leaves somebody who is not Site Admin with the stored roles and what they include", async () => {
    mocks.stored.mockResolvedValue(["manager"]);
    const roles = capability(41);
    expect(await roles.all()).toEqual(["manager", "clerk"]);
    expect(await roles.has("auditor")).toBe(false);
  });

  it("still answers no without an actor", async () => {
    mocks.admin.mockResolvedValue(true);
    expect(await capability(null).has("manager")).toBe(false);
    expect(await capability(null).all()).toEqual([]);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
