import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  getByEmail: vi.fn(),
  getById: vi.fn(),
  ensureAccount: vi.fn(),
  updateProfileFields: vi.fn(),
  updatePasswordHash: vi.fn(),
  updateFlags: vi.fn(),
  deleteAccount: vi.fn(),
  removeMembership: vi.fn(),
  getProfile: vi.fn(),
  upsertProfile: vi.fn(),
  getMembership: vi.fn(),
  upsertMembership: vi.fn(),
  createResetToken: vi.fn(),
  notify: vi.fn(),
  revokeSessions: vi.fn(),
  grants: vi.fn(),
  available: vi.fn(),
  installed: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteAdminOnlyApiContext: mocks.guard,
}));
vi.mock("@/db/user-accounts", () => ({
  deleteUserAccount: mocks.deleteAccount,
  ensureUserAccount: mocks.ensureAccount,
  getUserAccountByEmail: mocks.getByEmail,
  getUserAccountById: mocks.getById,
  removeUserAccountSiteMembership: mocks.removeMembership,
  updateUserAccountFlags: mocks.updateFlags,
  updateUserAccountPasswordHash: mocks.updatePasswordHash,
  updateUserAccountProfileFields: mocks.updateProfileFields,
}));
vi.mock("@/db/server-addon-roles.mts", () => ({
  readPhiSiteUsersAddonRoles: mocks.grants,
  readPhiSiteUserAddonRoles: vi.fn(),
}));
vi.mock("@/lib/addons/capability-snapshot", () => ({ readAvailablePhisProviderIds: mocks.available }));
vi.mock("@/lib/addons/installed", () => ({ getPhisAddonInstalledManifest: mocks.installed }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/user-admin", () => ({ listAdminUsersForSite: vi.fn(), setAdminUserEnabled: vi.fn() }));
vi.mock("@/db/user-password-reset-tokens", () => ({
  createUserPasswordResetToken: mocks.createResetToken,
}));
vi.mock("@/db/user-profiles", () => ({
  getUserProfileByUserId: mocks.getProfile,
  upsertUserProfile: mocks.upsertProfile,
}));
vi.mock("@/db/user-site-memberships", () => ({
  getUserSiteMembership: mocks.getMembership,
  upsertUserSiteMembership: mocks.upsertMembership,
}));
vi.mock("@/db/user-sessions", () => ({
  listUserSessionsForSite: vi.fn(),
  revokeUserSessionsForSite: mocks.revokeSessions,
}));
vi.mock("@/lib/email", () => ({ buildPasswordResetUrlForLocale: () => "https://site.test/reset" }));
vi.mock("@/lib/form-config", () => ({ getSiteMailConfig: async () => ({ publicBaseUrl: null }) }));
vi.mock("@/lib/notifications/enqueue", () => ({ notifyPhiPerson: mocks.notify }));
vi.mock("@/lib/log", () => ({
  logRuntimeEvent: vi.fn(),
  normalizeLogThrowable: (error: unknown) => error,
}));
vi.mock("@/lib/password", () => ({ hashPassword: async () => "hash" }));

import { listAdminUsersForSite } from "@/db/user-admin";

import { DELETE, GET, POST, PUT } from "./route";

const SITE = { id: 7, key: "example", defaultLocale: "en" };

function request(method: string, body?: unknown, query = "") {
  return new NextRequest(`https://server.test/api/site/admin/users${query}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function account(siteIds: number[]) {
  return {
    id: 41,
    emailNormalized: "person@example.test",
    medusaCustomerId: null,
    passwordHash: "their-hash",
    preferredLocale: null,
    siteIds,
    flags: 0,
    customerNumber: null,
  };
}

const RECORD = {
  userId: 41,
  email: "person@example.test",
  firstName: "Paula",
  lastName: "Person",
  companyName: null,
  roles: ["author"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue({ context: { site: SITE, session: { userId: 3 } }, error: null });
  mocks.getProfile.mockResolvedValue({
    userId: 41, firstName: "Paula", lastName: "Person", companyName: null,
  });
  mocks.getMembership.mockResolvedValue({ coreRoleFlags: 0, enabled: true });
  mocks.createResetToken.mockResolvedValue({ token: "token" });
  mocks.notify.mockResolvedValue("1");
});

describe("POST /api/site/admin/users", () => {
  it("adds an account of another Site as a member and leaves the account as it is", async () => {
    mocks.getByEmail.mockResolvedValue(account([2]));
    const response = await POST(request("POST", { ...RECORD, firstName: "Other", lastName: "Name" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId: 41, linkedExistingAccount: true });
    expect(mocks.upsertMembership).toHaveBeenCalledWith(expect.objectContaining({ userId: 41, siteId: 7 }));
    // Neither the password, the flags, nor the profile the other Site's person keeps.
    expect(mocks.ensureAccount).not.toHaveBeenCalled();
    expect(mocks.upsertProfile).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("creates an account nobody has and sends the first reset link", async () => {
    mocks.getByEmail.mockResolvedValue(null);
    mocks.ensureAccount.mockResolvedValue({ id: 50, emailNormalized: "new@example.test" });
    const response = await POST(request("POST", { ...RECORD, email: "new@example.test" }));

    expect(response.status).toBe(200);
    expect(mocks.ensureAccount).toHaveBeenCalledWith(expect.objectContaining({ reuseExisting: false }));
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("answers 409 when the address was registered between the lookup and the write", async () => {
    mocks.getByEmail.mockResolvedValue(null);
    mocks.ensureAccount.mockRejectedValue(new Error("ACCOUNT_EXISTS"));
    const response = await POST(request("POST", { ...RECORD, email: "new@example.test" }));
    expect(response.status).toBe(409);
  });
});

describe("PUT /api/site/admin/users", () => {
  it("refuses a new address for an account other Sites share", async () => {
    mocks.getById.mockResolvedValue(account([2, 7]));
    mocks.getByEmail.mockResolvedValue(null);
    const response = await PUT(request("PUT", { ...RECORD, email: "attacker@example.test" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "account_shared" });
    expect(mocks.updateProfileFields).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("refuses a password reset and a new name for a shared account", async () => {
    mocks.getById.mockResolvedValue(account([2, 7]));
    mocks.getByEmail.mockResolvedValue(account([2, 7]));
    expect((await PUT(request("PUT", { ...RECORD, changePassword: true }))).status).toBe(409);
    expect((await PUT(request("PUT", { ...RECORD, lastName: "Renamed" }))).status).toBe(409);
    expect(mocks.updateFlags).not.toHaveBeenCalled();
    expect(mocks.upsertProfile).not.toHaveBeenCalled();
  });

  it("signs out the person it tells to change their password", async () => {
    mocks.getById.mockResolvedValue(account([7]));
    mocks.getByEmail.mockResolvedValue(account([7]));
    const response = await PUT(request("PUT", { ...RECORD, changePassword: true }));

    expect(response.status).toBe(200);
    expect(mocks.updateFlags).toHaveBeenCalledWith(41, expect.objectContaining({ setFlags: 2 }));
    expect(mocks.revokeSessions).toHaveBeenCalledWith(41, 7);
  });

  it("still changes the roles of a shared account, which belong to this Site", async () => {
    mocks.getById.mockResolvedValue(account([2, 7]));
    mocks.getByEmail.mockResolvedValue(account([2, 7]));
    const response = await PUT(request("PUT", RECORD));

    expect(response.status).toBe(200);
    expect(mocks.upsertMembership).toHaveBeenCalledWith(expect.objectContaining({ userId: 41, siteId: 7 }));
    expect(mocks.updateProfileFields).not.toHaveBeenCalled();
    expect(mocks.upsertProfile).not.toHaveBeenCalled();
  });

  it("keeps the roles of a save that does not mention them", async () => {
    mocks.getById.mockResolvedValue(account([7]));
    mocks.getByEmail.mockResolvedValue(null);
    mocks.getMembership.mockResolvedValue({ coreRoleFlags: 8, enabled: true });
    const { roles: _roles, ...withoutRoles } = RECORD;
    void _roles;
    const response = await PUT(request("PUT", withoutRoles));

    expect(response.status).toBe(200);
    expect(mocks.upsertMembership).toHaveBeenCalledWith(expect.objectContaining({ coreRoleFlags: 8 }));
  });

  it("edits address and name of an account that belongs to this Site alone", async () => {
    mocks.getById.mockResolvedValue(account([7]));
    mocks.getByEmail.mockResolvedValue(null);
    const response = await PUT(request("PUT", { ...RECORD, email: "moved@example.test" }));

    expect(response.status).toBe(200);
    expect(mocks.updateProfileFields).toHaveBeenCalledWith(
      41,
      expect.objectContaining({ email: "moved@example.test" }),
    );
    expect(mocks.upsertProfile).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/site/admin/users", () => {
  it("removes only the membership of a shared account", async () => {
    mocks.getById.mockResolvedValue(account([2, 7]));
    const response = await DELETE(request("DELETE", undefined, "?userId=41"));

    expect(response.status).toBe(200);
    expect(mocks.removeMembership).toHaveBeenCalledWith(41, 7);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });
});

describe("GET /api/site/admin/users", () => {
  // Addresses, sign-in history and IPs are user administration, which AUTHORIZATION.md keeps to the Core
  // Admin; a Developer resolves to the admin Area but is not one.
  it("answers with the Admin-only guard's refusal", async () => {
    mocks.guard.mockResolvedValue({
      context: null,
      error: NextResponse.json({ error: "Forbidden." }, { status: 403 }),
    });
    const response = await GET(request("GET"));

    expect(response.status).toBe(403);
  });
});

const SHOP = "@acme/shop";
const SHOP_ROLES = [
  { name: "manager", grantableBy: { siteAccess: "site-admin" }, includes: ["clerk"] },
  { name: "clerk", grantableBy: { role: "manager" } },
];

function listRow(id: number) {
  return {
    id, displayName: `User ${id}`, emailNormalized: `u${id}@example.test`, accountType: "roles", enabled: true,
    flags: 0, siteFlags: 0, coreRoleFlags: 0, lastLoginAt: null, createdAt: "x", companyName: null,
    customerNumber: null, medusaCustomerId: null, firstName: null, lastName: null,
  };
}

describe("GET /api/site/admin/users with Add-on roles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockResolvedValue({ context: { site: SITE, session: { userId: 1 } }, error: null });
    vi.mocked(listAdminUsersForSite).mockResolvedValue(
      { rows: [listRow(10), listRow(11), listRow(12)], total: 3, siteTotal: 3, page: 1, pageSize: 20 } as never,
    );
    mocks.available.mockResolvedValue(new Set([SHOP]));
    mocks.installed.mockReturnValue({
      [SHOP]: { enabled: true, manifest: { addonId: SHOP, roles: SHOP_ROLES } },
      "@acme/off": { enabled: true, manifest: { addonId: "@acme/off", roles: [{ name: "x" }] } },
    });
    mocks.grants.mockResolvedValue(new Map([
      [10, [{ addonId: SHOP, role: "manager" }, { addonId: "@acme/off", role: "x" }, { addonId: SHOP, role: "retired" }]],
      [11, [{ addonId: SHOP, role: "clerk" }]],
    ]));
  });

  async function list(query = "") {
    const response = await GET(request("GET", undefined, query));
    return { response, body: await response.clone().json() };
  }

  it("shows each user's stored roles of Add-ons this Site runs, in one read for the page", async () => {
    const { body } = await list();

    expect(body.rows.map((row: { addonRoles: unknown }) => row.addonRoles)).toEqual([
      // `clerk` is implied by `manager` and not listed; the Add-on not available here and the dropped role are out.
      [{ addonId: SHOP, role: "manager" }],
      [{ addonId: SHOP, role: "clerk" }],
      [],
    ]);
    expect(mocks.grants).toHaveBeenCalledOnce();
    expect(mocks.grants.mock.calls[0]![1]).toEqual({ siteId: 7, userIds: [10, 11, 12] });
  });

  it("shows no roles of an Add-on that is not available on the Site", async () => {
    mocks.available.mockResolvedValue(new Set());

    const { body } = await list();

    expect(body.rows.map((row: { addonRoles: unknown[] }) => row.addonRoles.length)).toEqual([0, 0, 0]);
  });

  it("filters by Add-on to every declared role, stored", async () => {
    await list(`?addonId=${encodeURIComponent(SHOP)}`);

    expect(vi.mocked(listAdminUsersForSite).mock.calls[0]![1]).toMatchObject({
      addonRoles: { addonId: SHOP, roles: ["manager", "clerk"] },
    });
  });

  it("filters by role to the stored holders and those through `includes`", async () => {
    await list(`?addonId=${encodeURIComponent(SHOP)}&addonRole=clerk`);
    expect(vi.mocked(listAdminUsersForSite).mock.calls[0]![1]).toMatchObject({
      addonRoles: { addonId: SHOP, roles: ["manager", "clerk"] },
    });

    await list(`?addonId=${encodeURIComponent(SHOP)}&addonRole=manager`);
    expect(vi.mocked(listAdminUsersForSite).mock.calls[1]![1]).toMatchObject({
      addonRoles: { addonId: SHOP, roles: ["manager"] },
    });
  });

  it("matches nobody for an unknown Add-on, an undeclared role or an Add-on not available here", async () => {
    await list("?addonId=%40nobody%2Fnone");
    await list(`?addonId=${encodeURIComponent(SHOP)}&addonRole=nonesuch`);
    mocks.available.mockResolvedValue(new Set());
    await list(`?addonId=${encodeURIComponent(SHOP)}`);

    expect(vi.mocked(listAdminUsersForSite).mock.calls).toHaveLength(3);
    for (const call of vi.mocked(listAdminUsersForSite).mock.calls) {
      expect(call[1]?.addonRoles?.roles).toEqual([]);
    }
  });

  it("refuses malformed filters with 400 and does not query", async () => {
    for (const query of ["?addonId=", "?addonRole=clerk", `?addonId=${encodeURIComponent(SHOP)}&addonRole=Bad%20Role`]) {
      expect((await GET(request("GET", undefined, query))).status).toBe(400);
    }
    expect(listAdminUsersForSite).not.toHaveBeenCalled();
  });
});
