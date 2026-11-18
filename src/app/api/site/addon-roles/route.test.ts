import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  installed: vi.fn(),
  available: vi.fn(),
  membership: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  held: vi.fn(),
  replace: vi.fn(),
  actorRoles: vi.fn(),
  actorClaims: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/guards/site-admin-api", () => ({ requireSiteAuthenticatedApiContext: mocks.context }));
vi.mock("@/lib/addons/installed.ts", () => ({ getPhisAddonInstalledManifest: mocks.installed }));
vi.mock("@/lib/addons/capability-snapshot", () => ({ readAvailablePhisProviderIds: mocks.available }));
vi.mock("@/db/user-site-memberships", () => ({
  getUserSiteMembership: mocks.membership,
  // The actor is a Site Admin unless a case says otherwise.
  getEffectiveUserSiteAuthorization: async (userId: number) => ({
    enabled: true,
    roleClaims: mocks.actorClaims(userId),
    groupClaims: [],
  }),
}));
vi.mock("@/db/server-addon-roles.mts", () => ({
  grantPhisAddonUserRole: mocks.grant,
  revokePhisAddonUserRole: mocks.revoke,
  readPhiSiteUserAddonRoles: mocks.held,
  readPhisAddonUserRoles: mocks.actorRoles,
  replacePhisAddonUserRoles: mocks.replace,
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));
vi.mock("@/lib/authorization", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authorization")>("@/lib/authorization");
  return { ...actual, canPhiViewerAccess: (viewer: { roleClaims: unknown[] }) => viewer.roleClaims.length > 0 };
});

import { GET, POST, PUT } from "./route";

const ADDON = "@test/market";
const ADMIN_CLAIMS = [{ providerId: "@phis/server/core", flags: 2 }];

function post(body: unknown) {
  return POST(new NextRequest("https://core.test/api/site/addon-roles", { method: "POST", body: JSON.stringify(body) }));
}

/*
 * An Add-on's roles are handed out on a Site to that Site's members, and only for an Add-on the Site runs.
 * A grant to a stranger is a row nobody on the Site can see or take back; a role of an Add-on the Site does
 * not run starts to count the day somebody enables it.
 */
describe("granting an Add-on role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ context: { site: { id: 7, key: "site" }, session: { userId: 1 } }, error: null });
    mocks.installed.mockReturnValue({
      [ADDON]: { enabled: true, manifest: { addonId: ADDON, roles: [{ name: "vendor", grantableBy: { siteAccess: "site-admin" } }] } },
    });
    mocks.available.mockResolvedValue(new Set([ADDON]));
    mocks.membership.mockResolvedValue({ userId: 42, siteId: 7 });
    mocks.grant.mockResolvedValue(true);
    mocks.actorClaims.mockReturnValue(ADMIN_CLAIMS);
  });

  it("grants to a member of the Site", async () => {
    const response = await post({ addonId: ADDON, role: "vendor", userId: 42 });

    expect(response.status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledOnce();
  });

  it("refuses a user who is not a member of the Site", async () => {
    mocks.membership.mockResolvedValue(null);

    const response = await post({ addonId: ADDON, role: "vendor", userId: 42 });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "user_not_member" });
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("refuses a role of an Add-on that does not count here: not enabled, or enabled but not available", async () => {
    mocks.available.mockResolvedValue(new Set());

    const response = await post({ addonId: ADDON, role: "vendor", userId: 42 });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "addon_unknown" });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
});

const LADDER = [
  { name: "market-admin", grantableBy: { siteAccess: "site-admin" }, includes: ["vendor"] },
  { name: "vendor", description: "Sells", grantableBy: { role: "market-admin" } },
  { name: "auditor", grantableBy: { siteAccess: "site-admin" } },
];

function put(body: unknown) {
  return PUT(new NextRequest("https://core.test/api/site/addon-roles", { method: "PUT", body: JSON.stringify(body) }));
}

function get(query = "") {
  return GET(new NextRequest(`https://core.test/api/site/addon-roles${query}`));
}

function asMarketAdmin() {
  // Not a Site Admin, holding `market-admin` in the Add-on.
  mocks.actorClaims.mockReturnValue([]);
  mocks.actorRoles.mockResolvedValue(["market-admin"]);
}

describe("the Add-on role catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ context: { site: { id: 7, key: "site" }, session: { userId: 1 } }, error: null });
    mocks.installed.mockReturnValue({
      [ADDON]: { enabled: true, manifest: { addonId: ADDON, roles: LADDER } },
      // Enabled, but not available on the Site: its roles do not count here.
      "@test/off": { enabled: true, manifest: { addonId: "@test/off", roles: [{ name: "x", grantableBy: { siteAccess: "site-admin" } }] } },
    });
    mocks.available.mockResolvedValue(new Set([ADDON]));
    mocks.actorClaims.mockReturnValue(ADMIN_CLAIMS);
    mocks.actorRoles.mockResolvedValue([]);
    mocks.held.mockResolvedValue([]);
  });

  it("lists every declared role of the Add-ons that count here, each marked grantable for a Site Admin", async () => {
    const body = await (await get()).json();

    expect(body).toEqual({
      addons: [{
        addonId: ADDON,
        title: ADDON,
        roles: [
          { name: "market-admin", grantableBy: { siteAccess: "site-admin" }, includes: ["vendor"], grantable: true },
          { name: "vendor", description: "Sells", grantableBy: { role: "market-admin" }, grantable: true },
          { name: "auditor", grantableBy: { siteAccess: "site-admin" }, grantable: true },
        ],
      }],
    });
  });

  it("marks only what the caller may grant, and still lists the rest", async () => {
    asMarketAdmin();

    const body = await (await get()).json();

    expect(body.addons[0].roles.map((role: { name: string; grantable: boolean }) => [role.name, role.grantable]))
      .toEqual([["market-admin", false], ["vendor", true], ["auditor", false]]);
  });

  it("adds what one person holds, and refuses that to a caller who may grant nothing", async () => {
    const vendor = { addonId: ADDON, role: "vendor", grantedAt: "2026-01-01T00:00:00.000Z", grantedByUserId: 1 };
    mocks.held.mockResolvedValue([
      vendor,
      // Stored, but not counting here -- a role the manifest dropped, an Add-on not available: not shown.
      { ...vendor, role: "retired" },
      { ...vendor, addonId: "@test/off", role: "x" },
    ]);
    const body = await (await get("?userId=42")).json();
    expect(body.userId).toBe(42);
    expect(body.held).toEqual([vendor]);
    // The target (42) is the same stand-in claim set as the caller here: a Site Admin.
    expect(body.holdsAll).toBe(true);

    mocks.actorClaims.mockReturnValue([]);
    mocks.actorRoles.mockResolvedValue([]);
    expect((await get("?userId=42")).status).toBe(403);
    expect((await get("?userId=abc")).status).toBe(400);
  });
});

describe("setting the roles one person holds in an Add-on", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ context: { site: { id: 7, key: "site" }, session: { userId: 1 } }, error: null });
    mocks.installed.mockReturnValue({
      [ADDON]: { enabled: true, manifest: { addonId: ADDON, roles: LADDER } },
      "@test/off": { enabled: true, manifest: { addonId: "@test/off", roles: [{ name: "x", grantableBy: { siteAccess: "site-admin" } }] } },
    });
    mocks.available.mockResolvedValue(new Set([ADDON]));
    mocks.membership.mockResolvedValue({ userId: 42, siteId: 7 });
    mocks.actorClaims.mockReturnValue(ADMIN_CLAIMS);
    mocks.actorRoles.mockResolvedValue([]);
    mocks.held.mockResolvedValue([
      { addonId: ADDON, role: "vendor", grantedAt: "x", grantedByUserId: 1 },
      { addonId: ADDON, role: "retired", grantedAt: "x", grantedByUserId: 1 },
      { addonId: "@test/other", role: "vendor", grantedAt: "x", grantedByUserId: 1 },
    ]);
    mocks.replace.mockResolvedValue({ granted: ["auditor"], revoked: ["vendor"] });
  });

  it("writes the difference only, leaving a stored role the manifest dropped and another Add-on's alone", async () => {
    const response = await put({ userId: 42, addonId: ADDON, roles: ["auditor"] });

    expect(response.status).toBe(200);
    expect(mocks.replace).toHaveBeenCalledOnce();
    expect(mocks.replace.mock.calls[0]![1]).toMatchObject({
      addonId: ADDON, siteId: 7, userId: 42, grant: ["auditor"], revoke: ["vendor"], grantedByUserId: 1,
    });
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["addons", "held", "holdsAll", "userId"]);
  });

  it("says whether the person holds every role, and keeps the stored list as it is", async () => {
    // Caller 1 is a Site Admin; person 42 is not.
    mocks.actorClaims.mockImplementation((userId: number) => (userId === 1 ? ADMIN_CLAIMS : []));
    const plain = await (await get("?userId=42")).json();
    expect(plain.holdsAll).toBe(false);
    // The stored roles that count: not `retired` (dropped), not another Add-on's that is not installed.
    expect(plain.held.map((grant: { role: string }) => grant.role)).toEqual(["vendor"]);

    // 42 is a Site Admin: nothing is refused or changed for it; held is still the stored list.
    mocks.actorClaims.mockReturnValue(ADMIN_CLAIMS);
    const response = await put({ userId: 42, addonId: ADDON, roles: [] });
    expect(response.status).toBe(200);
    expect(mocks.replace.mock.calls[0]![1]).toMatchObject({ grant: [], revoke: ["vendor"] });
    const body = await response.json();
    expect(body.holdsAll).toBe(true);
    expect(body.held).toHaveLength(1);
  });

  it("refuses all of it when one role of the difference is beyond the caller", async () => {
    asMarketAdmin();

    // Taking `vendor` back is allowed; giving `auditor` needs a Site Admin.
    const response = await put({ userId: 42, addonId: ADDON, roles: ["auditor"] });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_permitted", role: "auditor" });
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("does not ask about a role it leaves as it is", async () => {
    asMarketAdmin();

    const response = await put({ userId: 42, addonId: ADDON, roles: ["vendor"] });

    expect(response.status).toBe(200);
    expect(mocks.replace.mock.calls[0]![1]).toMatchObject({ grant: [], revoke: [] });
  });

  it("answers like the single calls: unknown Add-on, undeclared role, stranger, malformed body", async () => {
    const unknown = await put({ userId: 42, addonId: "@test/off", roles: [] });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "addon_unknown" });
    mocks.available.mockResolvedValue(new Set());
    expect((await put({ userId: 42, addonId: ADDON, roles: [] })).status).toBe(404);
    mocks.available.mockResolvedValue(new Set([ADDON]));

    const undeclared = await put({ userId: 42, addonId: ADDON, roles: ["nonesuch"] });
    expect(undeclared.status).toBe(404);
    expect(await undeclared.json()).toEqual({ error: "role_undeclared" });

    mocks.membership.mockResolvedValue(null);
    const stranger = await put({ userId: 42, addonId: ADDON, roles: [] });
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toEqual({ error: "user_not_member" });

    expect((await put({ userId: 42, addonId: ADDON, roles: "vendor" })).status).toBe(400);
    expect((await put({ userId: 0, addonId: ADDON, roles: [] })).status).toBe(400);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
