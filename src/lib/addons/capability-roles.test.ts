import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every place a request's capabilities ask a role, for a role a Site access implies: `roles:v1`, the
 * guard of a declared query (`data:v1`'s `hasRole`), and a slot's `requiresRole` (`assets:v1`'s). All of
 * them are answered by the one `roles:v1` the request is built with, and that one shares the actor's
 * authorization snapshot with `authorization:v1`: it is read once for the request, however many questions
 * are put to it.
 *
 * The data and assets capabilities are stood in for, keeping only the `hasRole` they are handed; that
 * they refuse on it is `server-addon-query-roles.pg.test.ts`'s and the assets lifecycle's to show.
 */

const mocks = vi.hoisted(() => ({
  accesses: [] as string[],
  snapshot: vi.fn(),
  stored: vi.fn(),
  dataHasRole: null as null | ((role: string) => Promise<boolean>),
  assetsHasRole: null as null | ((role: string) => Promise<boolean>),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getPool: () => ({}),
}));
vi.mock("./site-access.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./site-access.ts")>()),
  readPhisSiteAccessHolder: async (...args: unknown[]) => {
    mocks.snapshot(...args);
    return (access: string) => mocks.accesses.includes(access);
  },
}));
vi.mock("@/db/server-addon-roles.mts", () => ({ readPhisAddonUserRoles: mocks.stored }));
vi.mock("./data-capability.ts", () => ({
  buildPhisAddonDataCapability: (input: { hasRole: (role: string) => Promise<boolean> }) => {
    mocks.dataHasRole = input.hasRole;
    return {};
  },
}));
vi.mock("./assets-capability.ts", () => ({
  buildPhisAddonAssetsCapability: (input: { hasRole: (role: string) => Promise<boolean> }) => {
    mocks.assetsHasRole = input.hasRole;
    return {};
  },
}));

import { PHIS_CORE_CAPABILITIES } from "@phis/contracts/addon";
import { buildPhisAddonCapabilities } from "./capabilities.ts";

const manifest = {
  addonId: "@acme/books",
  requiredCoreCapabilities: [
    PHIS_CORE_CAPABILITIES.authorization,
    PHIS_CORE_CAPABILITIES.roles,
    PHIS_CORE_CAPABILITIES.data,
    PHIS_CORE_CAPABILITIES.assets,
  ],
  roles: [
    { name: "owner", grantableBy: { siteAccess: "site-admin" } },
    { name: "bookkeeper", grantableBy: { role: "owner" }, impliedBy: { siteAccess: "accounting" }, includes: ["reader"] },
    { name: "reader", grantableBy: { role: "owner" } },
  ],
  schema: null,
} as never;

function build(actorUserId: number | null) {
  return buildPhisAddonCapabilities({
    manifest,
    manifestDigest: "probe",
    siteId: 3,
    siteKey: "books",
    actorUserId,
  });
}

describe("a role a Site access implies, wherever a request asks it", () => {
  beforeEach(() => {
    mocks.accesses = ["accounting"];
    mocks.snapshot.mockReset();
    mocks.stored.mockReset().mockResolvedValue([]);
    mocks.dataHasRole = null;
    mocks.assetsHasRole = null;
  });

  it("is held in roles:v1, by a query guard and by a slot, from one read of the snapshot", async () => {
    const capabilities = build(41);
    expect(await capabilities.roles!.has("bookkeeper")).toBe(true);
    expect(await capabilities.roles!.has("reader")).toBe(true);
    expect(await capabilities.roles!.has("owner")).toBe(false);
    expect(await mocks.dataHasRole!("bookkeeper")).toBe(true);
    expect(await mocks.assetsHasRole!("reader")).toBe(true);
    expect(await mocks.assetsHasRole!("owner")).toBe(false);
    expect(await capabilities.authorization!.hasSiteAccess("accounting")).toBe(true);
    expect(await capabilities.authorization!.hasSiteAccess("support")).toBe(false);
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(mocks.snapshot).toHaveBeenCalledWith(3, 41);
  });

  it("is not held without the access, and nobody acting reads nothing", async () => {
    mocks.accesses = ["support"];
    expect(await build(41).roles!.has("bookkeeper")).toBe(false);
    expect(await mocks.dataHasRole!("bookkeeper")).toBe(false);

    mocks.snapshot.mockReset();
    const anonymous = build(null);
    expect(await anonymous.roles!.has("bookkeeper")).toBe(false);
    expect(await anonymous.authorization!.hasSiteAccess("accounting")).toBe(false);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});
