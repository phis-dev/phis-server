import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getByEmail: vi.fn(),
  ensureAccount: vi.fn(),
  verifyPassword: vi.fn(),
  notify: vi.fn(),
  createIntent: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: () => null }));
vi.mock("@/lib/site-context", () => ({
  requireSiteFromRequest: async () => ({ id: 7, key: "site", defaultLocale: "en" }),
}));
vi.mock("@/db/site-config", () => ({ getSiteConfigBySiteId: async () => null }));
vi.mock("@/lib/form-config", () => ({
  getFormGuardSecret: async () => "secret",
  getFormTimingWindow: () => ({}),
  getSiteMailConfig: async () => ({}),
}));
vi.mock("@/lib/form-guard", () => ({ verifyFormGuard: () => ({ ok: true }) }));
vi.mock("@/lib/form-abuse-log", () => ({ logFormAbuse: vi.fn() }));
vi.mock("@/db/site-auth", () => ({
  getSiteAuthPolicy: async () => ({ registrationMode: "automatic", existingAccountLinking: "password" }),
}));
vi.mock("@/db/user-accounts", () => ({
  getUserAccountByEmail: mocks.getByEmail,
  ensureUserAccount: mocks.ensureAccount,
}));
vi.mock("@/lib/password", () => ({ verifyPasswordHash: mocks.verifyPassword }));
vi.mock("@/lib/site-auth/password-method", () => ({
  isSitePasswordMethodEnabled: async () => true,
  PASSWORD_METHOD_DISABLED_RESPONSE: { code: "method_disabled" },
}));
vi.mock("@/lib/site-auth/attempt-limit", () => ({
  checkAuthAttemptLimit: () => null,
  tooManyAttemptsResponse: vi.fn(),
}));
vi.mock("@/db/registration-intents", () => ({ createRegistrationIntent: mocks.createIntent }));
vi.mock("@/db/user-profiles", () => ({ getUserProfileByUserId: vi.fn(), upsertUserProfile: vi.fn() }));
vi.mock("@/db/user-site-memberships", () => ({ upsertUserSiteMembership: vi.fn() }));
vi.mock("@/lib/email", () => ({ buildVerificationUrlForLocale: () => "https://site.test/verify" }));
vi.mock("@/lib/notifications/enqueue", () => ({ notifyPhiPerson: mocks.notify }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));

import { POST } from "./route";
import { USER_ACCOUNT_FLAG_DISABLED } from "@/lib/user-flags";

function request() {
  return new Request("https://server.test/api/v1/forms/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Paula", lastName: "Person", email: "paula@example.test",
      password: "long-enough-1", confirmPassword: "long-enough-1", termsAccepted: true,
    }),
  });
}

const ACCEPTED = { ok: true, status: "pending_verification" };

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 41, emailNormalized: "paula@example.test", passwordHash: "hash", siteIds: [2],
    flags: 0, medusaCustomerId: null, ...overrides,
  };
}

function noticeSent() {
  return mocks.notify.mock.calls.some(([input]) => input.occasion === "registration_account_exists");
}

/**
 * Whether an address has an account is not something the form tells anybody. Every outcome but a
 * proven link answers like a new registration; the owner of the address hears about it by mail.
 */
describe("registration and existing addresses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.notify.mockResolvedValue("1");
    mocks.createIntent.mockResolvedValue({
      id: 1, email: "new@example.test", firstName: "Paula", lastName: "Person", locale: "en",
      verificationToken: "token", fullName: "Paula Person",
    });
  });

  it("answers a new address with the pending answer and a verification mail", async () => {
    mocks.getByEmail.mockResolvedValue(null);
    const response = await POST(request());
    expect(await response.json()).toEqual(ACCEPTED);
    expect(noticeSent()).toBe(false);
  });

  it("answers a disabled account the same way, and links nothing", async () => {
    mocks.getByEmail.mockResolvedValue(account({ flags: USER_ACCOUNT_FLAG_DISABLED }));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ACCEPTED);
    expect(mocks.ensureAccount).not.toHaveBeenCalled();
    expect(noticeSent()).toBe(true);
  });

  it("answers a wrong password the same way", async () => {
    mocks.getByEmail.mockResolvedValue(account());
    mocks.verifyPassword.mockResolvedValue(false);
    expect(await (await POST(request())).json()).toEqual(ACCEPTED);
    expect(mocks.ensureAccount).not.toHaveBeenCalled();
  });

  it("answers an account that already belongs to this Site the same way", async () => {
    mocks.getByEmail.mockResolvedValue(account({ siteIds: [7] }));
    expect(await (await POST(request())).json()).toEqual(ACCEPTED);
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(noticeSent()).toBe(true);
  });

  it("links an enabled account whose password is proven", async () => {
    mocks.getByEmail.mockResolvedValue(account());
    mocks.ensureAccount.mockResolvedValue({ id: 41, emailNormalized: "paula@example.test" });
    const response = await POST(request());
    expect(await response.json()).toMatchObject({ ok: true, linkedExistingAccount: true });
    expect(mocks.ensureAccount).toHaveBeenCalledTimes(1);
  });
});
