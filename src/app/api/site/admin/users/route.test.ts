import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  maintainerGuard: vi.fn(),
  history: vi.fn(),
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
  save: vi.fn(),
  held: vi.fn(),
  mayGrant: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteAdminOnlyApiContext: mocks.guard,
  requireSiteMaintainerApiContext: mocks.maintainerGuard,
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
  readPhiSiteUserAddonRoles: mocks.held,
}));
vi.mock("@/db/user-admin-save", () => ({ saveSiteUser: mocks.save }));
vi.mock("@/lib/addons/role-granting", () => ({ mayGrantPhisAddonRole: mocks.mayGrant }));
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
  listUserSessionsForSite: mocks.history,
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
import { PhiBaseRole } from "@/lib/constants/phi-base-roles";
import { canPhiViewerAccess, PHI_ACCESS_SITE_MAINTENANCE, PHI_CORE_ROLE_PROVIDER_ID } from "@/lib/authorization";

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
    passwordHash: "their-hash",
    preferredLocale: null,
    siteIds,
    flags: 0,
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
  mocks.maintainerGuard.mockResolvedValue({ context: { site: SITE, session: { userId: 3 } }, error: null });
  mocks.getProfile.mockResolvedValue({
    userId: 41, firstName: "Paula", lastName: "Person", companyName: null,
  });
  mocks.getMembership.mockResolvedValue({ coreRoleFlags: 0, enabled: true });
  mocks.createResetToken.mockResolvedValue({ token: "token" });
  mocks.notify.mockResolvedValue("1");
  mocks.save.mockResolvedValue({ granted: [], revoked: [] });
  mocks.grants.mockResolvedValue(new Map());
  mocks.available.mockResolvedValue(new Set());
  mocks.held.mockResolvedValue([]);
  mocks.installed.mockReturnValue({});
  mocks.mayGrant.mockResolvedValue({ allowed: true });
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
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("refuses a password reset and a new name for a shared account", async () => {
    mocks.getById.mockResolvedValue(account([2, 7]));
    mocks.getByEmail.mockResolvedValue(account([2, 7]));
    expect((await PUT(request("PUT", { ...RECORD, changePassword: true }))).status).toBe(409);
    expect((await PUT(request("PUT", { ...RECORD, lastName: "Renamed" }))).status).toBe(409);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("signs out the person it tells to change their password", async () => {
    mocks.getById.mockResolvedValue(account([7]));
    mocks.getByEmail.mockResolvedValue(account([7]));
    const response = await PUT(request("PUT", { ...RECORD, changePassword: true }));

    expect(response.status).toBe(200);
    // The reset and the sessions it ends are written by the one transaction `saveSiteUser` is.
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ passwordReset: { newPasswordHash: null } }));
  });

  it("still changes the roles of a shared account, which belong to this Site", async () => {
    mocks.getById.mockResolvedValue(account([2, 7]));
    mocks.getByEmail.mockResolvedValue(account([2, 7]));
    const response = await PUT(request("PUT", RECORD));

    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 41, siteId: 7, account: null, coreRoleFlags: expect.any(Number) }));
  });

  it("keeps the roles of a save that does not mention them", async () => {
    mocks.getById.mockResolvedValue(account([7]));
    mocks.getByEmail.mockResolvedValue(null);
    mocks.getMembership.mockResolvedValue({ coreRoleFlags: 8, enabled: true });
    const { roles: _roles, ...withoutRoles } = RECORD;
    void _roles;
    const response = await PUT(request("PUT", withoutRoles));

    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ coreRoleFlags: 8, addonRoles: null }));
  });

  it("edits address and name of an account that belongs to this Site alone", async () => {
    mocks.getById.mockResolvedValue(account([7]));
    mocks.getByEmail.mockResolvedValue(null);
    const response = await PUT(request("PUT", { ...RECORD, email: "moved@example.test" }));

    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      account: expect.objectContaining({ newEmail: "moved@example.test", firstName: "Paula" }),
    }));
  });
});

describe("PUT /api/site/admin/users with Add-on roles", () => {
  const SHOP_ADDON = "@acme/shop";
  const BLOG_ADDON = "@acme/blog";
  const shopRoles = [{ name: "clerk" }, { name: "manager" }];
  const blogRoles = [{ name: "editor" }];

  beforeEach(() => {
    mocks.getById.mockResolvedValue(account([7]));
    mocks.getByEmail.mockResolvedValue(null);
    // `@acme/off` is installed and enabled, but not available on the Site: its roles do not count here.
    mocks.installed.mockReturnValue({
      [SHOP_ADDON]: { enabled: true, manifest: { addonId: SHOP_ADDON, roles: shopRoles } },
      [BLOG_ADDON]: { enabled: true, manifest: { addonId: BLOG_ADDON, roles: blogRoles } },
      "@acme/off": { enabled: true, manifest: { addonId: "@acme/off", roles: [{ name: "x" }] } },
    });
    mocks.available.mockResolvedValue(new Set([SHOP_ADDON, BLOG_ADDON]));
    mocks.held.mockResolvedValue([
      { addonId: SHOP_ADDON, role: "clerk" },
      { addonId: BLOG_ADDON, role: "editor" },
      // Not declared any more, and an Add-on that does not count here: neither is touched.
      { addonId: SHOP_ADDON, role: "retired" },
      { addonId: "@acme/off", role: "x" },
    ]);
  });

  const put = (addonRoles?: unknown) => PUT(request("PUT", addonRoles === undefined ? RECORD : { ...RECORD, addonRoles }));

  it("leaves the Add-on roles alone when the field is absent", async () => {
    const response = await put();

    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ addonRoles: null }));
    expect(mocks.held).not.toHaveBeenCalled();
    expect(mocks.mayGrant).not.toHaveBeenCalled();
  });

  it("takes the difference over every Add-on of the Site, from \"<addonId>:<role>\" strings", async () => {
    // Wanted: shop manager (new), blog editor (kept). Not wanted any more: shop clerk.
    const response = await put([`${SHOP_ADDON}:manager`, `${BLOG_ADDON}:editor`]);

    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 3,
      addonRoles: {
        grant: [{ addonId: SHOP_ADDON, role: "manager" }],
        revoke: [{ addonId: SHOP_ADDON, role: "clerk" }],
      },
    }));
  });

  it("rejects the object form { addonId, role } with 400 and stores nothing", async () => {
    const response = await put([{ addonId: SHOP_ADDON, role: "manager" }]);

    expect(response.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("takes every role of an Add-on back that the list no longer names, and none of an unlisted-but-undeclared one", async () => {
    await put([]);

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      addonRoles: { grant: [], revoke: [{ addonId: SHOP_ADDON, role: "clerk" }, { addonId: BLOG_ADDON, role: "editor" }] },
    }));
  });

  it("checks the standing for every role it gives or takes, with the declared roles of its Add-on", async () => {
    await put([`${SHOP_ADDON}:manager`]);

    expect(mocks.mayGrant).toHaveBeenCalledTimes(3);
    expect(mocks.mayGrant).toHaveBeenCalledWith(expect.objectContaining({
      addonId: SHOP_ADDON, siteId: 7, actorUserId: 3, role: "manager", declared: shopRoles,
    }));
    expect(mocks.mayGrant).toHaveBeenCalledWith(expect.objectContaining({ addonId: BLOG_ADDON, role: "editor" }));
  });

  it("stores nothing when one role may not be given: 403 with the role", async () => {
    mocks.mayGrant.mockImplementation(async (input: { role: string }) =>
      input.role === "editor" ? { allowed: false, reason: "not_permitted" } : { allowed: true });

    const response = await put([`${SHOP_ADDON}:manager`]);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_permitted", addonId: BLOG_ADDON, role: "editor" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("answers 404 addon_unknown for an Add-on that does not count here, naming the role", async () => {
    for (const addonId of ["@acme/off", "@acme/nonesuch"]) {
      const response = await put([`${addonId}:x`]);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "addon_unknown", addonId, role: "x" });
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("answers 404 role_undeclared for an Add-on that counts but declares no roles", async () => {
    mocks.installed.mockReturnValue({ "@acme/plain": { enabled: true, manifest: { addonId: "@acme/plain" } } });
    mocks.available.mockResolvedValue(new Set(["@acme/plain"]));

    const response = await put(["@acme/plain:x"]);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "role_undeclared", addonId: "@acme/plain", role: "x" });
  });

  it("leaves a stored role of an Add-on enabled but not available as it is, when the list sent is what GET showed", async () => {
    mocks.grants.mockResolvedValue(new Map([[41, [
      { addonId: SHOP_ADDON, role: "clerk" }, { addonId: BLOG_ADDON, role: "editor" }, { addonId: "@acme/off", role: "x" },
    ]]]));
    const shown = (await (await GET(request("GET", undefined, "?userId=41"))).json()).user.addonRoles;
    expect(shown).toEqual([`${SHOP_ADDON}:clerk`, `${BLOG_ADDON}:editor`]);

    const response = await put(shown);

    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ addonRoles: { grant: [], revoke: [] } }));
    expect(mocks.mayGrant).not.toHaveBeenCalled();
  });

  it("answers 404 role_undeclared for a role the Add-on does not declare", async () => {
    const response = await put([`${SHOP_ADDON}:retired`]);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "role_undeclared", addonId: SHOP_ADDON, role: "retired" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("answers 404 user_not_member when the person has no membership here", async () => {
    mocks.getMembership.mockResolvedValue(null);

    const response = await put([]);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "user_not_member" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([
    ["a string", "shop:clerk"],
    ["an object", { addonId: SHOP_ADDON, role: "clerk" }],
    ["an entry without a role", [SHOP_ADDON]],
    ["an entry with an empty part", [`${SHOP_ADDON}:`]],
    ["a number", [3]],
    ["an object without an addonId", [{ role: "clerk" }]],
  ])("refuses %s as the list with 400 before anything is read or written", async (_name, value) => {
    const response = await put(value);

    expect(response.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.held).not.toHaveBeenCalled();
  });

  it("lets a Site Admin set the Add-on roles of their own account; only the Core role is locked", async () => {
    mocks.getById.mockResolvedValue({ ...account([7]), id: 3 });
    mocks.getMembership.mockResolvedValue({ coreRoleFlags: 8, enabled: true });

    const response = await put([`${SHOP_ADDON}:clerk`, `${BLOG_ADDON}:editor`]);

    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ coreRoleFlags: null, addonRoles: { grant: [], revoke: [] } }));
  });

  it("answers the saved row with the stored Add-on roles that count, as GET lists them", async () => {
    mocks.available.mockResolvedValue(new Set([SHOP_ADDON]));
    mocks.installed.mockReturnValue({ [SHOP_ADDON]: { enabled: true, manifest: { addonId: SHOP_ADDON, roles: shopRoles } } });
    mocks.grants.mockResolvedValue(new Map([[41, [{ addonId: SHOP_ADDON, role: "manager" }, { addonId: BLOG_ADDON, role: "editor" }]]]));

    const response = await put([`${SHOP_ADDON}:manager`]);

    expect(await response.json()).toMatchObject({ userId: 41, addonRoles: [`${SHOP_ADDON}:manager`], impliedAddonRoles: [] });
  });

  it("answers what the saved Core roles imply beside the stored roles, and stores none of it", async () => {
    mocks.installed.mockReturnValue({
      [SHOP_ADDON]: {
        enabled: true,
        manifest: { addonId: SHOP_ADDON, roles: [{ name: "clerk" }, { name: "books", impliedBy: { siteAccess: "accounting" } }] },
      },
    });
    mocks.held.mockResolvedValue([]);

    const response = await PUT(request("PUT", { ...RECORD, roles: ["accountant"], addonRoles: [] }));

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ addonRoles: { grant: [], revoke: [] } }));
    expect(await response.json()).toMatchObject({
      addonRoles: [],
      impliedAddonRoles: [{ addonId: SHOP_ADDON, role: "books", through: { siteAccess: "accounting" } }],
    });
  });

  it("answers 409 when the address was taken between the check and the write", async () => {
    mocks.save.mockRejectedValue(new Error("EMAIL_TAKEN"));

    expect((await put([])).status).toBe(409);
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
  // Addresses and the user records are user administration, which AUTHORIZATION.md keeps to the Core
  // Admin; a Maintainer resolves to the admin Area but is not one.
  it("answers with the Admin-only guard's refusal", async () => {
    mocks.guard.mockResolvedValue({
      context: null,
      error: NextResponse.json({ error: "Forbidden." }, { status: 403 }),
    });
    const response = await GET(request("GET"));

    expect(response.status).toBe(403);
    expect(mocks.maintainerGuard).not.toHaveBeenCalled();
  });
});

/*
 * The login history is the one read a Site Maintainer is given (owner, 2026-11-26). The policy is
 * checked for real below; here, that the history asks the Maintainer guard and nothing else does.
 */
describe("GET /api/site/admin/users?historyUserId", () => {
  it("asks the Maintainer guard and answers the history", async () => {
    mocks.getById.mockResolvedValue(account([7]));
    mocks.history.mockResolvedValue([{ id: "s1" }]);
    const response = await GET(request("GET", undefined, "?historyUserId=41"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 41, sessions: [{ id: "s1" }] });
    expect(mocks.maintainerGuard).toHaveBeenCalledTimes(1);
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it("answers with the Maintainer guard's refusal", async () => {
    mocks.maintainerGuard.mockResolvedValue({
      context: null,
      error: NextResponse.json({ error: "Forbidden." }, { status: 403 }),
    });
    const response = await GET(request("GET", undefined, "?historyUserId=41"));

    expect(response.status).toBe(403);
    expect(mocks.history).not.toHaveBeenCalled();
  });

  // An unreadable id never falls through to the list, which is the Admin's.
  it("refuses an unreadable id instead of answering the list", async () => {
    const response = await GET(request("GET", undefined, "?historyUserId=12abc"));

    expect(response.status).toBe(400);
    expect(listAdminUsersForSite).not.toHaveBeenCalled();
  });

  it("is open to the Site Admin and the Maintainer, not to a Supporter or a member", () => {
    const reach = (flags: number) => canPhiViewerAccess({
      authenticated: true,
      roleClaims: flags === 0 ? [] : [{ providerId: PHI_CORE_ROLE_PROVIDER_ID, flags }],
      groupClaims: [],
    }, PHI_ACCESS_SITE_MAINTENANCE);

    expect(reach(PhiBaseRole.Admin)).toBe(true);
    expect(reach(PhiBaseRole.Maintainer)).toBe(true);
    expect(reach(PhiBaseRole.Supporter)).toBe(false);
    expect(reach(0)).toBe(false);
  });
});

const SHOP = "@acme/shop";
const SHOP_ROLES = [
  { name: "manager", grantableBy: { siteAccess: "site-admin" }, includes: ["clerk"] },
  { name: "clerk", grantableBy: { role: "manager" } },
];

function listRow(id: number) {
  return {
    id, displayName: `User ${id}`, emailNormalized: `u${id}@example.test`, accountType: "staff", enabled: true,
    flags: 0, siteFlags: 0, coreRoleFlags: 0, lastLoginAt: null, createdAt: "x", companyName: null,
    firstName: null, lastName: null,
  };
}

describe("GET /api/site/admin/users?userId with Add-on roles", () => {
  it("lists the stored Add-on roles that count in the single read the dialog pre-fills from", async () => {
    mocks.getById.mockResolvedValue(account([7]));
    mocks.available.mockResolvedValue(new Set(["@acme/shop"]));
    mocks.installed.mockReturnValue({
      "@acme/shop": { enabled: true, manifest: { addonId: "@acme/shop", roles: [{ name: "clerk" }] } },
    });
    mocks.grants.mockResolvedValue(new Map([[41, [{ addonId: "@acme/shop", role: "clerk" }, { addonId: "@acme/shop", role: "gone" }]]]));

    const response = await GET(request("GET", undefined, "?userId=41"));

    const { user } = await response.json();
    expect(user.addonRoles).toEqual(["@acme/shop:clerk"]);
    expect(user.impliedAddonRoles).toEqual([]);
    expect(mocks.grants.mock.calls[0]![1]).toEqual({ siteId: 7, userIds: [41] });
  });

  it("lists beside them what the person's Core roles imply, from the membership it read", async () => {
    mocks.getById.mockResolvedValue(account([7]));
    mocks.getMembership.mockResolvedValue({ coreRoleFlags: PhiBaseRole.Accountant, enabled: true });
    mocks.available.mockResolvedValue(new Set(["@acme/shop"]));
    mocks.installed.mockReturnValue({
      "@acme/shop": {
        enabled: true,
        manifest: {
          addonId: "@acme/shop",
          roles: [{ name: "books", impliedBy: { siteAccess: "accounting" }, includes: ["clerk"] }, { name: "clerk" }],
        },
      },
    });
    mocks.grants.mockResolvedValue(new Map([[41, [{ addonId: "@acme/shop", role: "clerk" }]]]));

    const { user } = await (await GET(request("GET", undefined, "?userId=41"))).json();

    // `clerk` is stored and implied through `books`: listed in both, the stored one the save sends back.
    expect(user.addonRoles).toEqual(["@acme/shop:clerk"]);
    expect(user.impliedAddonRoles).toEqual([
      { addonId: "@acme/shop", role: "books", through: { siteAccess: "accounting" } },
      { addonId: "@acme/shop", role: "clerk", through: { siteAccess: "accounting" } },
    ]);
  });
});

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

  it("shows beside them what a Site access implies, from the rows' Core roles, never for a Site Admin or a disabled member", async () => {
    mocks.installed.mockReturnValue({
      [SHOP]: { enabled: true, manifest: { addonId: SHOP, roles: [{ ...SHOP_ROLES[0], impliedBy: { siteAccess: "accounting" } }, SHOP_ROLES[1]] } },
    });
    mocks.grants.mockResolvedValue(new Map());
    vi.mocked(listAdminUsersForSite).mockResolvedValue({
      rows: [
        { ...listRow(10), coreRoleFlags: PhiBaseRole.Accountant },
        { ...listRow(11), coreRoleFlags: PhiBaseRole.Maintainer },
        { ...listRow(12), coreRoleFlags: PhiBaseRole.Admin | PhiBaseRole.Accountant },
        { ...listRow(13), coreRoleFlags: PhiBaseRole.Accountant, enabled: false },
        { ...listRow(14), coreRoleFlags: PhiBaseRole.Supporter },
      ],
      total: 5, siteTotal: 5, page: 1, pageSize: 20,
    } as never);

    const { body } = await list();

    const implied = [
      { addonId: SHOP, role: "manager", through: { siteAccess: "accounting" } },
      { addonId: SHOP, role: "clerk", through: { siteAccess: "accounting" } },
    ];
    expect(body.rows.map((row: { impliedAddonRoles: unknown }) => row.impliedAddonRoles))
      .toEqual([implied, implied, [], [], []]);
    expect(body.rows.map((row: { addonRoles: unknown[] }) => row.addonRoles.length)).toEqual([0, 0, 0, 0, 0]);
    expect(mocks.available).toHaveBeenCalledOnce();
  });

  it("reads no capability snapshot for a page nobody on which has a grant or an implying access", async () => {
    mocks.installed.mockReturnValue({
      [SHOP]: { enabled: true, manifest: { addonId: SHOP, roles: [{ ...SHOP_ROLES[0], impliedBy: { siteAccess: "accounting" } }, SHOP_ROLES[1]] } },
    });
    mocks.grants.mockResolvedValue(new Map());
    vi.mocked(listAdminUsersForSite).mockResolvedValue({
      rows: [{ ...listRow(10), coreRoleFlags: PhiBaseRole.Supporter }, listRow(11)],
      total: 2, siteTotal: 2, page: 1, pageSize: 20,
    } as never);

    const { body } = await list();

    expect(body.rows.map((row: { impliedAddonRoles: unknown[] }) => row.impliedAddonRoles)).toEqual([[], []]);
    expect(mocks.available).not.toHaveBeenCalled();
  });

  it("shows no roles of an Add-on that is not available on the Site", async () => {
    mocks.available.mockResolvedValue(new Set());

    const { body } = await list();

    expect(body.rows.map((row: { addonRoles: unknown[] }) => row.addonRoles.length)).toEqual([0, 0, 0]);
  });

  it("filters by account type staff or customer and reads any other value as all", async () => {
    await list("?accountType=staff");
    await list("?accountType=Customer");
    await list("?accountType=roles");
    await list("?accountType=auth");

    expect(vi.mocked(listAdminUsersForSite).mock.calls.map(call => call[1]?.accountType))
      .toEqual(["staff", "customer", "all", "all"]);
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
      // No role here is implied by a Site access: no Core roles beside the Site Admins.
      addonRoles: { addonId: SHOP, roles: ["manager", "clerk"], impliedByRoleFlags: 0 },
    });

    await list(`?addonId=${encodeURIComponent(SHOP)}&addonRole=manager`);
    expect(vi.mocked(listAdminUsersForSite).mock.calls[1]![1]).toMatchObject({
      addonRoles: { addonId: SHOP, roles: ["manager"] },
    });
  });

  it("adds the Core roles of a Site access a matching role is implied by", async () => {
    mocks.installed.mockReturnValue({
      [SHOP]: {
        enabled: true,
        manifest: {
          addonId: SHOP,
          roles: [
            { ...SHOP_ROLES[0], impliedBy: { siteAccess: "accounting" } },
            SHOP_ROLES[1],
            { name: "helpdesk", grantableBy: { siteAccess: "site-admin" }, impliedBy: { siteAccess: "support" } },
          ],
        },
      },
    });
    const accounting = PhiBaseRole.Maintainer | PhiBaseRole.Accountant;
    const support = PhiBaseRole.Maintainer | PhiBaseRole.Supporter;

    // `clerk` is held through `manager`, which accounting implies; `helpdesk` does not lead to `clerk`.
    await list(`?addonId=${encodeURIComponent(SHOP)}&addonRole=clerk`);
    expect(vi.mocked(listAdminUsersForSite).mock.calls[0]![1]).toMatchObject({
      addonRoles: { addonId: SHOP, roles: ["manager", "clerk"], impliedByRoleFlags: accounting },
    });
    await list(`?addonId=${encodeURIComponent(SHOP)}&addonRole=helpdesk`);
    expect(vi.mocked(listAdminUsersForSite).mock.calls[1]![1]).toMatchObject({
      addonRoles: { addonId: SHOP, roles: ["helpdesk"], impliedByRoleFlags: support },
    });
    // Any role of the Add-on: every access one of them is implied by.
    await list(`?addonId=${encodeURIComponent(SHOP)}`);
    expect(vi.mocked(listAdminUsersForSite).mock.calls[2]![1]).toMatchObject({
      addonRoles: { addonId: SHOP, roles: ["manager", "clerk", "helpdesk"], impliedByRoleFlags: accounting | support },
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
