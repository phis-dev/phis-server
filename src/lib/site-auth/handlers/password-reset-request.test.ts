import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  scheduled: [] as Array<() => Promise<void>>,
  getUser: vi.fn(),
  createToken: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => { mocks.scheduled.push(task); },
}));
vi.mock("@/lib/site-auth/authenticated-site-user", () => ({
  requireCsrfCheckedSite: async () => ({ ok: true, site: { id: 1, key: "acme", defaultLocale: "de" } }),
}));
vi.mock("@/lib/site-auth/password-method", () => ({
  isSitePasswordMethodEnabled: async () => true,
  PASSWORD_METHOD_DISABLED_RESPONSE: {},
}));
vi.mock("@/lib/site-auth/attempt-limit", () => ({
  checkAuthAttemptLimit: () => null,
  tooManyAttemptsResponse: vi.fn(),
}));
vi.mock("@/db/user-accounts", () => ({ getUserAccountByEmail: mocks.getUser }));
vi.mock("@/db/user-site-memberships", () => ({
  getEffectiveUserSiteAuthorization: async () => ({ enabled: true }),
}));
vi.mock("@/db/user-password-reset-tokens", () => ({ createUserPasswordResetToken: mocks.createToken }));
vi.mock("@/lib/form-config", () => ({ getSiteMailConfig: async () => ({ publicBaseUrl: "https://acme.test" }) }));
vi.mock("@/lib/email", () => ({ buildPasswordResetUrlForRequest: () => "https://acme.test/reset" }));
vi.mock("@/lib/notifications/enqueue", () => ({ notifyPhiPerson: mocks.notify }));
vi.mock("@/lib/user-flags", () => ({ isUserAccountEnabled: () => true }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));

import { POST } from "./password-reset-request";

function request(email: string) {
  return POST(new NextRequest("https://acme.test/api/v1/auth/password/reset/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }));
}

/**
 * The answer must not depend on whether the address has an account: the lookup, the token and the mail
 * happen after it is out, so neither its content nor its timing tells the two apart.
 */
describe("password reset request", () => {
  beforeEach(() => {
    mocks.scheduled.length = 0;
    mocks.getUser.mockReset();
    mocks.createToken.mockReset().mockResolvedValue({ token: "t" });
    mocks.notify.mockReset().mockResolvedValue(11);
  });

  it("answers before it looks the address up", async () => {
    const response = await request("known@acme.test");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.scheduled).toHaveLength(1);
  });

  it("issues the token and the mail afterwards, for an account that exists", async () => {
    mocks.getUser.mockResolvedValue({ id: 7, siteIds: [1], passwordHash: "h", flags: 0 });
    await request("known@acme.test");
    await mocks.scheduled[0]!();
    expect(mocks.createToken).toHaveBeenCalledWith({ userId: 7, siteId: 1 });
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it("does nothing afterwards for an address without an account", async () => {
    mocks.getUser.mockResolvedValue(null);
    const response = await request("nobody@acme.test");
    expect(await response.json()).toEqual({});
    await mocks.scheduled[0]!();
    expect(mocks.createToken).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("keeps a failure in the background out of the answer", async () => {
    mocks.getUser.mockRejectedValue(new Error("db down"));
    expect((await request("known@acme.test")).status).toBe(200);
    await expect(mocks.scheduled[0]!()).resolves.toBeUndefined();
  });
});
