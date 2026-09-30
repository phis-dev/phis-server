import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  method: vi.fn(),
  hasTotp: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  sessionFromRequest: vi.fn(),
  revokeSession: vi.fn(),
}));

vi.mock("@/db/site-auth", () => ({
  getSiteAuthPolicy: mocks.policy,
  getSiteAuthMethod: mocks.method,
}));
vi.mock("@/db/user-auth-factors", () => ({
  hasConfirmedTotpFactor: mocks.hasTotp,
}));
vi.mock("@/db/user-sessions", () => ({
  createUserSession: mocks.createSession,
  getSessionFromRequest: mocks.sessionFromRequest,
  revokeUserSessionForSite: mocks.revokeSession,
  updateUserSessionAuthState: mocks.updateSession,
}));

import { NextRequest } from "next/server";

import {
  beginSiteAuthenticationSession,
  reevaluateCompleteSession,
  resolveRequiredSessionState,
  siteFactorPolicyRequiresTotp,
} from "./assurance";
import { PHI_AUTH_SESSION_STATES } from "./contracts";

const requiredPolicy = {
  revision: 4,
  factorPolicy: {
    requiredMethod: "totp",
    enforcement: "next-login",
    graceUntil: null,
    roleFlags: 0,
  },
};

beforeEach(() => {
  mocks.policy.mockReset().mockResolvedValue(requiredPolicy);
  mocks.method.mockReset().mockResolvedValue({ enabled: true });
  mocks.hasTotp.mockReset().mockResolvedValue(false);
  mocks.createSession.mockReset().mockResolvedValue({
    id: "session-id",
    secret: "secret",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  });
  mocks.updateSession.mockReset();
  mocks.sessionFromRequest.mockReset().mockResolvedValue(null);
  mocks.revokeSession.mockReset().mockResolvedValue(true);
});

const loginRequest = () => new NextRequest("https://server.test/api/v1/auth/login", { method: "POST" });

describe("Site authentication assurance", () => {
  it("requires enrollment on login when the required TOTP factor is missing", async () => {
    const result = await resolveRequiredSessionState({
      siteId: 7,
      userId: 42,
      coreRoleFlags: 0,
      authMethodKeys: ["password"],
      login: true,
    });

    expect(result).toEqual({
      state: PHI_AUTH_SESSION_STATES.factorEnrollmentRequired,
      policyRevision: 4,
      deferred: false,
    });
  });

  it("requires a challenge when a confirmed TOTP factor exists", async () => {
    mocks.hasTotp.mockResolvedValue(true);

    const result = await resolveRequiredSessionState({
      siteId: 7,
      userId: 42,
      coreRoleFlags: 0,
      authMethodKeys: ["google"],
      login: true,
    });

    expect(result.state).toBe(PHI_AUTH_SESSION_STATES.factorChallengeRequired);
  });

  it("creates a restricted session without Area assurance before enrollment", async () => {
    const session = await beginSiteAuthenticationSession({
      request: loginRequest(),
      userId: 42,
      siteId: 7,
      coreRoleFlags: 0,
      authMethodKeys: ["password"],
      nextPath: "/admin",
    });

    expect(session.authState).toBe(PHI_AUTH_SESSION_STATES.factorEnrollmentRequired);
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      assuranceLevel: 0,
      authState: PHI_AUTH_SESSION_STATES.factorEnrollmentRequired,
      authPolicyRevision: 4,
      nextPath: "/admin",
    }));
  });

  it("revokes the session the browser arrived with, once the new one exists", async () => {
    const request = loginRequest();
    mocks.sessionFromRequest.mockResolvedValue({ id: "previous-session", userId: 9 });

    await beginSiteAuthenticationSession({
      request,
      userId: 42,
      siteId: 7,
      coreRoleFlags: 0,
      authMethodKeys: ["password"],
      nextPath: "/",
    });

    // Only a cookie for this Site whose secret verifies names a session, whichever state it is in.
    expect(mocks.sessionFromRequest).toHaveBeenCalledWith(request, 7, {
      allowDisabled: true,
      allowIncomplete: true,
      allowPasswordChangeRequired: true,
    });
    expect(mocks.revokeSession).toHaveBeenCalledWith({
      sessionId: "previous-session",
      userId: 9,
      siteId: 7,
    });
    expect(mocks.createSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.revokeSession.mock.invocationCallOrder[0]!);
  });

  it("revokes nothing when the browser carries no session for this Site", async () => {
    await beginSiteAuthenticationSession({
      request: loginRequest(),
      userId: 42,
      siteId: 7,
      coreRoleFlags: 0,
      authMethodKeys: ["password"],
      nextPath: "/",
    });
    expect(mocks.revokeSession).not.toHaveBeenCalled();
  });

  it("scopes the required factor to the roles the policy names", () => {
    const scoped = { requiredMethod: "totp" as const, roleFlags: 0b0100 };
    expect(siteFactorPolicyRequiresTotp(scoped, 0b0100)).toBe(true);
    expect(siteFactorPolicyRequiresTotp(scoped, 0b0001)).toBe(false);
    expect(siteFactorPolicyRequiresTotp({ requiredMethod: "totp", roleFlags: 0 }, 0)).toBe(true);
    expect(siteFactorPolicyRequiresTotp({ requiredMethod: null, roleFlags: 0 }, 0b0100)).toBe(false);
  });

  it("does not interrupt an existing session for next-login enforcement", async () => {
    const result = await resolveRequiredSessionState({
      siteId: 7,
      userId: 42,
      coreRoleFlags: 0,
      authMethodKeys: ["password"],
      login: false,
    });

    expect(result.state).toBe(PHI_AUTH_SESSION_STATES.complete);
  });

  it("keeps a session under a running grace deadline stale, to ask it again once passed", async () => {
    const stale = {
      sessionId: "session-id", siteId: 7, userId: 42, coreRoleFlags: 0,
      authMethodKeys: ["password"], authPolicyRevision: 3,
    };
    mocks.policy.mockResolvedValue({
      ...requiredPolicy,
      factorPolicy: { ...requiredPolicy.factorPolicy, enforcement: "grace",
        graceUntil: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(await reevaluateCompleteSession(stale)).toBe(PHI_AUTH_SESSION_STATES.complete);
    // The revision is not recorded: recording it is what made the deadline unreachable.
    expect(mocks.updateSession).not.toHaveBeenCalled();

    mocks.policy.mockResolvedValue({
      ...requiredPolicy,
      factorPolicy: { ...requiredPolicy.factorPolicy, enforcement: "grace",
        graceUntil: new Date(Date.now() - 1_000).toISOString() },
    });
    expect(await reevaluateCompleteSession(stale))
      .toBe(PHI_AUTH_SESSION_STATES.factorEnrollmentRequired);
    expect(mocks.updateSession).toHaveBeenCalledWith(expect.objectContaining({
      authState: PHI_AUTH_SESSION_STATES.factorEnrollmentRequired,
      authPolicyRevision: 4,
    }));
  });

  it("records the revision under next-login, which an existing session never meets", async () => {
    await reevaluateCompleteSession({
      sessionId: "session-id", siteId: 7, userId: 42, coreRoleFlags: 0,
      authMethodKeys: ["password"], authPolicyRevision: 3,
    });
    expect(mocks.updateSession).toHaveBeenCalledWith(expect.objectContaining({ authPolicyRevision: 4 }));
  });
});
