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
vi.mock("@/lib/email", () => ({ buildPasswordResetUrlForRequest: () => "https://site.test/reset" }));
vi.mock("@/lib/form-config", () => ({ getSiteMailConfig: async () => ({ publicBaseUrl: null }) }));
vi.mock("@/lib/notifications/enqueue", () => ({ notifyPhiPerson: mocks.notify }));
vi.mock("@/lib/log", () => ({
  logRuntimeEvent: vi.fn(),
  normalizeLogThrowable: (error: unknown) => error,
}));
vi.mock("@/lib/password", () => ({ hashPassword: async () => "hash" }));

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
