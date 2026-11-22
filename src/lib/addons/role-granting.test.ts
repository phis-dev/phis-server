import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A `{ role }` grant policy met through a role a Site access implies, in the two places that decide it:
 * the write (`mayGrantPhisAddonRole`, and through it the group writer) and the catalog user administration
 * renders. Both answer every access question from one read of the actor's authorization snapshot.
 *
 * Against a real database the same is `server-addon-roles.pg.test.ts`'s to show; here the reads are counted.
 */

const mocks = vi.hoisted(() => ({
  accesses: [] as string[],
  snapshot: vi.fn(),
  stored: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("./site-access.ts", () => ({
  readPhisSiteAccessHolder: async (...args: unknown[]) => {
    mocks.snapshot(...args);
    return (access: string) => mocks.accesses.includes(access);
  },
}));
vi.mock("@/db/server-addon-roles.mts", () => ({ readPhisAddonUserRoles: mocks.stored }));

const declared = [
  { name: "owner", grantableBy: { siteAccess: "site-admin" as const } },
  { name: "bookkeeper", grantableBy: { role: "owner" }, impliedBy: { siteAccess: "accounting" as const }, includes: ["reader"] },
  { name: "reader", grantableBy: { role: "owner" } },
  { name: "ledger", grantableBy: { role: "reader" } },
  { name: "auditor", grantableBy: { siteAccess: "accounting" as const } },
];

vi.mock("./viewer-roles.ts", () => ({
  listPhiCountingAddonDeclaredRoles: () => new Map([["@acme/books", declared]]),
}));

import { mayGrantPhisAddonRole, readPhisAddonRoleCatalog } from "./role-granting.ts";

const grant = (role: string) =>
  mayGrantPhisAddonRole({ addonId: "@acme/books", siteId: 3, actorUserId: 41, role, declared });

describe("a grant policy met through a role a Site access implies", () => {
  beforeEach(() => {
    mocks.accesses = ["accounting"];
    mocks.snapshot.mockReset();
    mocks.stored.mockReset().mockResolvedValue([]);
  });

  it("lets a holder of the access grant what the implied role and its inclusions may grant", async () => {
    // `ledger` is granted by `reader`, which `bookkeeper` includes, which accounting implies.
    expect((await grant("ledger")).allowed).toBe(true);
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    // `reader` is granted by `owner`, which nothing implies.
    expect(await grant("reader")).toEqual({ allowed: false, reason: "not_permitted" });
  });

  it("refuses the same to somebody without the access", async () => {
    mocks.accesses = ["support"];
    expect(await grant("ledger")).toEqual({ allowed: false, reason: "not_permitted" });
  });

  it("marks the same roles grantable in the catalog, from one read of the snapshot", async () => {
    const catalog = await readPhisAddonRoleCatalog({ siteId: 3, actorUserId: 41, availableProviderIds: new Set(["@acme/books"]) });
    expect(catalog[0]!.roles.map((role) => [role.name, role.grantable])).toEqual([
      ["owner", false],
      ["bookkeeper", false],
      ["reader", false],
      ["ledger", true],
      ["auditor", true],
    ]);
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(mocks.stored).toHaveBeenCalledTimes(1);
  });

  it("reads nothing stored for a Site Admin, who may grant everything", async () => {
    mocks.accesses = ["site-admin"];
    const catalog = await readPhisAddonRoleCatalog({ siteId: 3, actorUserId: 41, availableProviderIds: new Set(["@acme/books"]) });
    expect(catalog[0]!.roles.every((role) => role.grantable)).toBe(true);
    expect((await grant("owner")).allowed).toBe(true);
    expect(mocks.stored).not.toHaveBeenCalled();
  });
});
