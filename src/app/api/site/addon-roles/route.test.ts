import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  installed: vi.fn(),
  enabled: vi.fn(),
  membership: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  held: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/guards/site-admin-api", () => ({ requireSiteAuthenticatedApiContext: mocks.context }));
vi.mock("@/lib/addons/installed.ts", () => ({ getPhisAddonInstalledManifest: mocks.installed }));
vi.mock("@/db/server-addons", () => ({ isPhisAddonEnabledForSite: mocks.enabled }));
vi.mock("@/db/user-site-memberships", () => ({
  getUserSiteMembership: mocks.membership,
  // The actor is a Site Admin: the grant policy is not what these cases are about.
  getEffectiveUserSiteAuthorization: async () => ({
    enabled: true,
    roleClaims: [{ providerId: "@phis/server/core", flags: 2 }],
    groupClaims: [],
  }),
}));
vi.mock("@/db/server-addon-roles.mts", () => ({
  grantPhisAddonUserRole: mocks.grant,
  revokePhisAddonUserRole: mocks.revoke,
  readPhiSiteUserAddonRoles: mocks.held,
  readPhisAddonUserRoles: async () => [],
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));
vi.mock("@/lib/authorization", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authorization")>("@/lib/authorization");
  return { ...actual, canPhiViewerAccess: () => true };
});

import { POST } from "./route";

const ADDON = "@test/market";

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
      [ADDON]: { manifest: { addonId: ADDON, roles: [{ name: "vendor", grantableBy: { siteAccess: "site-admin" } }] } },
    });
    mocks.enabled.mockResolvedValue(true);
    mocks.membership.mockResolvedValue({ userId: 42, siteId: 7 });
    mocks.grant.mockResolvedValue(true);
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

  it("refuses a role of an Add-on this Site does not run", async () => {
    mocks.enabled.mockResolvedValue(false);

    const response = await post({ addonId: ADDON, role: "vendor", userId: 42 });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "addon_unknown" });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
});
