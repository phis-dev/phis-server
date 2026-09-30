import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  siteContext: vi.fn(),
  manifest: vi.fn(),
  csrf: vi.fn(),
  runtime: vi.fn(),
  start: vi.fn(),
  setAuthFlowCookie: vi.fn(),
  legacyPasswordLogin: vi.fn(),
  complete: vi.fn(),
  createLink: vi.fn(),
  confirmLink: vi.fn(),
  resolveExternal: vi.fn(),
  authorization: vi.fn(),
  beginSession: vi.fn(),
  recordLogin: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: mocks.guard }));
vi.mock("@/lib/site-context", () => ({
  requireSiteFromExplicitKeyRequest: mocks.siteContext,
}));
vi.mock("@/lib/site-auth/manifest", () => ({ buildPublicAuthManifest: mocks.manifest }));
vi.mock("@/db/sites", () => ({ getSiteRuntimeConfig: mocks.runtime }));
vi.mock("@/lib/site-auth/provider-flow", () => ({
  startProviderAuthentication: mocks.start,
  completeProviderAuthentication: mocks.complete,
}));
vi.mock("@/lib/site-auth/identity-link-flow", () => ({
  createExternalIdentityLinkChallenge: mocks.createLink,
  confirmExternalIdentityLink: mocks.confirmLink,
}));
vi.mock("@/lib/site-auth/external-login", () => ({ resolveExternalLogin: mocks.resolveExternal }));
vi.mock("@/db/user-site-memberships", () => ({
  getEffectiveUserSiteAuthorization: mocks.authorization,
  recordUserSiteLogin: mocks.recordLogin,
}));
vi.mock("@/lib/site-auth/assurance", () => ({
  beginSiteAuthenticationSession: mocks.beginSession,
}));
vi.mock("@/db/user-accounts", () => ({ getUserAccountById: mocks.getUser }));
vi.mock("@/lib/site-auth/handlers/password-login", () => ({ POST: mocks.legacyPasswordLogin }));
vi.mock("@/lib/log", () => ({
  logRuntimeEvent: vi.fn(),
  normalizeLogThrowable: (error: unknown) => error,
}));
vi.mock("@/lib/auth", () => ({
  AUTH_LINK_COOKIE_NAME: "phis_auth_link",
  AUTH_FLOW_COOKIE_NAME: "phis_auth_flow",
  setAuthFlowCookie: mocks.setAuthFlowCookie,
  clearAuthFlowCookie: vi.fn(),
  verifyCsrfRequest: mocks.csrf,
  createCsrfToken: () => "csrf-test",
  readRequestIp: () => "127.0.0.1",
  readRequestUserAgent: () => "vitest",
  setAreaCookie: vi.fn(),
  clearAreaCookie: vi.fn(),
  setCsrfCookie: vi.fn(),
  setSessionCookie: vi.fn(),
  setThemeModeCookie: vi.fn(),
  setAuthLinkCookie: vi.fn(),
  clearAuthLinkCookie: vi.fn(),
  // The language a sign-in serves is decided in the real module and tested there; here it only has to
  // answer, because a mock that leaves it out makes every provider route throw on its own success path.
  resolveSignedInLocale: () => "en",
  setLocaleCookie: vi.fn(),
}));

import { GET as getManifest } from "./manifest/route";
import { POST as passwordLogin } from "./password/login/route";
import { GET as providerCallback } from "./providers/[provider]/callback/route";
import { POST as confirmProviderLink } from "./providers/link/confirm/route";
import { POST as providerStart } from "./providers/[provider]/start/route";

const site = { id: 7, key: "example", defaultLocale: "en" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockReturnValue(null);
  mocks.siteContext.mockResolvedValue({ site, error: null });
  mocks.csrf.mockReturnValue(true);
  mocks.runtime.mockResolvedValue({
    publicUrl: "https://example.test",
    defaultLocale: "en",
    availableLocales: [{ code: "en" }],
  });
  mocks.beginSession.mockResolvedValue({
    id: "session-id",
    secret: "session-secret",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    authState: 3,
    policyRevision: 1,
  });
});

describe("canonical Auth endpoints", () => {
  it("returns the site-specific public manifest without bypassing the internal guard", async () => {
    mocks.manifest.mockResolvedValue({ siteId: 7, methods: [{ key: "password" }] });
    const request = new Request("https://server.test/api/v1/auth/manifest?site=example");
    const response = await getManifest(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ siteId: 7, methods: [{ key: "password" }] });
    expect(mocks.guard).toHaveBeenCalledWith(request, { requireInternalToken: true });
  });

  it("short-circuits every canonical endpoint when the internal guard rejects", async () => {
    mocks.guard.mockReturnValueOnce(NextResponse.json({ error: "forbidden" }, { status: 403 }));
    const request = new NextRequest("https://server.test/api/v1/auth/password/login", {
      method: "POST",
    });
    const response = await passwordLogin(request);

    expect(response.status).toBe(403);
    expect(mocks.legacyPasswordLogin).not.toHaveBeenCalled();
  });

  it("delegates guarded password login to the shared Core handler", async () => {
    mocks.legacyPasswordLogin.mockResolvedValue(NextResponse.json({ ok: true }));
    const request = new NextRequest("https://server.test/api/v1/auth/password/login", {
      method: "POST",
    });
    const response = await passwordLogin(request);

    expect(response.status).toBe(200);
    expect(mocks.legacyPasswordLogin).toHaveBeenCalledWith(request);
  });

  it("requires CSRF before starting an external provider flow", async () => {
    mocks.csrf.mockReturnValue(false);
    const request = new NextRequest("https://server.test/api/v1/auth/providers/google/start?site=example", {
      method: "POST",
      body: JSON.stringify({ next: "/account" }),
    });
    const response = await providerStart(request, { params: Promise.resolve({ provider: "google" }) });

    expect(response.status).toBe(403);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("returns only the provider redirect URL from a successful start, and binds the state to the browser", async () => {
    const expiresAt = new Date("2030-01-01T00:10:00.000Z");
    mocks.start.mockResolvedValue({
      redirectUrl: "https://accounts.google.test/authorize?state=opaque",
      nextPath: "/account",
      state: "opaque",
      expiresAt,
    });
    const request = new NextRequest("https://server.test/api/v1/auth/providers/google/start?site=example", {
      method: "POST",
      body: JSON.stringify({ next: "/account" }),
    });
    const response = await providerStart(request, { params: Promise.resolve({ provider: "google" }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redirectUrl: "https://accounts.google.test/authorize?state=opaque",
    });
    // The state travels in a cookie as well: the callback answers only the browser that started here.
    expect(mocks.setAuthFlowCookie).toHaveBeenCalledWith(expect.anything(), "opaque", expiresAt);
  });

  it("refuses a provider callback from a browser that did not start the flow", async () => {
    // The state is valid, the URL was handed over: the cookie that would say "I started this" is missing.
    const request = new NextRequest(
      "https://server.test/api/v1/auth/providers/google/callback?site=example&code=code&state=state",
    );
    const response = await providerCallback(request, {
      params: Promise.resolve({ provider: "google" }),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.test/login?auth=provider_state_mismatch");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("creates a local session after a successful provider callback", async () => {
    mocks.complete.mockResolvedValue({
      identity: {
        issuer: "https://accounts.google.com",
        subject: "provider-subject",
        providerKey: "google",
        email: "user@example.test",
        emailVerified: true,
      },
      nextPath: "/account",
      trustedForAutoLink: false,
    });
    mocks.resolveExternal.mockResolvedValue({ ok: true, userId: 42, created: true, linked: false });
    mocks.authorization.mockResolvedValue({ enabled: true, roleClaims: [] });
    mocks.recordLogin.mockResolvedValue(undefined);
    mocks.getUser.mockResolvedValue({ preferredLocale: "en" });
    const request = new NextRequest(
      "https://server.test/api/v1/auth/providers/google/callback?site=example&code=code&state=state",
      { headers: { cookie: "phis_auth_flow=state" } },
    );
    const response = await providerCallback(request, {
      params: Promise.resolve({ provider: "google" }),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.test/account");
    expect(mocks.beginSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      siteId: 7,
      authMethodKeys: ["google"],
    }));
  });

  it("redirects a provider login to the Public factor workflow before granting an Area", async () => {
    mocks.complete.mockResolvedValue({
      identity: {
        issuer: "https://accounts.google.com",
        subject: "provider-subject",
        providerKey: "google",
        email: "user@example.test",
        emailVerified: true,
      },
      nextPath: "/admin",
      trustedForAutoLink: false,
    });
    mocks.resolveExternal.mockResolvedValue({ ok: true, userId: 42, created: false, linked: true });
    mocks.authorization.mockResolvedValue({ enabled: true, coreRoleFlags: 1, roleClaims: [] });
    mocks.beginSession.mockResolvedValueOnce({
      id: "session-id",
      secret: "session-secret",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      authState: 1,
      policyRevision: 4,
    });
    mocks.getUser.mockResolvedValue({ preferredLocale: "en" });
    const request = new NextRequest(
      "https://server.test/api/v1/auth/providers/google/callback?site=example&code=code&state=state",
      { headers: { cookie: "phis_auth_flow=state" } },
    );
    const response = await providerCallback(request, {
      params: Promise.resolve({ provider: "google" }),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://example.test/login?auth=continue&next=%2Fadmin",
    );
    expect(mocks.recordLogin).not.toHaveBeenCalled();
  });

  it("creates a one-use confirmation challenge when an existing account must be linked", async () => {
    mocks.complete.mockResolvedValue({
      identity: {
        issuer: "https://accounts.google.com",
        subject: "provider-subject",
        providerKey: "google",
        email: "user@example.test",
        emailVerified: true,
      },
      nextPath: "/admin",
      providerInstallationKey: "google",
      trustedForAutoLink: false,
    });
    mocks.resolveExternal.mockResolvedValue({ ok: false, code: "link_required", userId: 42 });
    mocks.createLink.mockResolvedValue({
      token: "opaque-link-token",
      expiresAt: new Date("2030-01-01T00:10:00.000Z"),
    });
    const request = new NextRequest(
      "https://server.test/api/v1/auth/providers/google/callback?site=example&code=code&state=state",
      { headers: { cookie: "phis_auth_flow=state" } },
    );
    const response = await providerCallback(request, {
      params: Promise.resolve({ provider: "google" }),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://example.test/login?auth=link_required&next=%2Fadmin",
    );
    expect(mocks.createLink).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 7,
      userId: 42,
      methodKey: "google",
      providerInstallationKey: "google",
    }));
  });

  it("links the provider after password confirmation and creates the Site session", async () => {
    mocks.confirmLink.mockResolvedValue({
      user: { id: 42, preferredLocale: "en" },
      authorization: {
        enabled: true,
        coreRoleFlags: 1,
        roleClaims: [{ providerId: "@phis/server/core", flags: 1 }],
      },
      methodKey: "google",
      nextPath: "/admin",
    });
    mocks.runtime.mockResolvedValue({
      publicUrl: "https://example.test",
      defaultLocale: "en",
      availableLocales: [{ code: "en" }],
    });
    const request = new NextRequest(
      "https://server.test/api/v1/auth/providers/link/confirm?site=example",
      {
        method: "POST",
        headers: {
          cookie: "phis_auth_link=opaque-link-token",
          "content-type": "application/json",
          "x-csrf-token": "csrf-test",
        },
        // Padded on purpose: the password is trimmed here as at every other entry point.
        body: JSON.stringify({ password: "  valid-password " }),
      },
    );
    const response = await confirmProviderLink(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      complete: true,
      next: "/admin",
      area: "admin",
    });
    expect(mocks.confirmLink).toHaveBeenCalledWith({
      siteId: 7,
      token: "opaque-link-token",
      password: "valid-password",
    });
    expect(mocks.beginSession).toHaveBeenCalledWith(expect.objectContaining({
      request,
      userId: 42,
      siteId: 7,
      authMethodKeys: ["google", "password"],
      nextPath: "/admin",
    }));
  });

  it("consumes a failed provider link confirmation without exposing account details", async () => {
    mocks.confirmLink.mockRejectedValue(new Error("AUTH_LINK_INVALID_CREDENTIALS"));
    const request = new NextRequest(
      "https://server.test/api/v1/auth/providers/link/confirm?site=example",
      {
        method: "POST",
        headers: {
          cookie: "phis_auth_link=opaque-link-token",
          "content-type": "application/json",
          "x-csrf-token": "csrf-test",
        },
        body: JSON.stringify({ password: "wrong-password" }),
      },
    );
    const response = await confirmProviderLink(request);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "The password is incorrect. The login provider was not linked.",
      code: "link_confirmation_invalid_credentials",
      returnToLogin: true,
    });
  });
});
