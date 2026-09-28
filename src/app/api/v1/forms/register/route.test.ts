import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getByEmail: vi.fn(),
  ensureAccount: vi.fn(),
  verifyPassword: vi.fn(),
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
vi.mock("@/db/registration-intents", () => ({ createRegistrationIntent: vi.fn() }));
vi.mock("@/db/user-profiles", () => ({ getUserProfileByUserId: vi.fn(), upsertUserProfile: vi.fn() }));
vi.mock("@/db/user-site-memberships", () => ({ upsertUserSiteMembership: vi.fn() }));
vi.mock("@/lib/email", () => ({ buildVerificationUrlForRequest: vi.fn() }));
vi.mock("@/lib/email-templates", () => ({ sendTemplatedEmail: vi.fn() }));
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

describe("registering with the address of an account on another Site", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyPassword.mockResolvedValue(true);
  });

  it("does not let a disabled account join, and answers as for a wrong password", async () => {
    mocks.getByEmail.mockResolvedValue({
      id: 41, emailNormalized: "paula@example.test", passwordHash: "hash", siteIds: [2],
      flags: USER_ACCOUNT_FLAG_DISABLED, medusaCustomerId: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid credentials." });
    expect(mocks.ensureAccount).not.toHaveBeenCalled();
  });

  it("lets an enabled account with the right password join", async () => {
    mocks.getByEmail.mockResolvedValue({
      id: 41, emailNormalized: "paula@example.test", passwordHash: "hash", siteIds: [2],
      flags: 0, medusaCustomerId: null,
    });
    mocks.ensureAccount.mockResolvedValue({ id: 41, emailNormalized: "paula@example.test" });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.ensureAccount).toHaveBeenCalledTimes(1);
  });
});
