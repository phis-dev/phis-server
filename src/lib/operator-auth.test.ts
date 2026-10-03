import { createHmac } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  runtime: { platformSuperUsers: [] as Record<string, unknown>[] },
}));

vi.mock("@/lib/config", () => ({ getPhisConfigSync: mocks.config }));
// The operator list the session is checked against, held in memory instead of the runtime file.
vi.mock("@/lib/config-files", () => ({
  readPhiRuntimeConfigSync: () => mocks.runtime,
  writePhiRuntimeConfigSync: (next: typeof mocks.runtime) => {
    mocks.runtime = next;
  },
}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import {
  buildOperatorSessionExpiresAt,
  endOperatorSessions,
  getOperatorSessionFromRequest,
  OPERATOR_SESSION_COOKIE_NAME,
  setOperatorSessionCookie,
} from "./operator-auth";

/**
 * Operator sessions are signed cookies, so the signing key is the whole of their security. It used to
 * be the internal API token -- held by every Site runtime -- with the registration key as a fallback.
 * These pin the key to `operator.sessionSecret` and nothing else.
 */
describe("operator session signing", () => {
  const internalToken = "internal-token-every-site-holds";
  const sessionSecret = "operator-only-secret";

  function requestWithCookie(value: string) {
    return new NextRequest("https://server.test/api/operator/auth/refresh", {
      method: "POST",
      headers: { cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${value}` },
    });
  }

  function forge(secret: string) {
    const payload = Buffer.from(JSON.stringify({
      email: "someone@example.invalid",
      displayName: "Someone",
      expiresAt: Date.now() + 60_000,
      generation: 0,
    }), "utf8").toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  }

  beforeEach(() => {
    mocks.config.mockReset();
    mocks.runtime = {
      platformSuperUsers: [
        { email: "op@example.invalid", passwordHash: "x" },
        { email: "someone@example.invalid", passwordHash: "x" },
      ],
    };
  });

  it("signs and reads back with the dedicated key", () => {
    mocks.config.mockReturnValue({ operator: { sessionSecret }, api: { internalToken } });
    const response = NextResponse.json({});
    setOperatorSessionCookie(response, {
      email: "Op@Example.invalid",
      displayName: "Op",
      expiresAt: buildOperatorSessionExpiresAt(),
      generation: 0,
    });
    const value = response.cookies.get(OPERATOR_SESSION_COOKIE_NAME)!.value;

    expect(getOperatorSessionFromRequest(requestWithCookie(value))).toMatchObject({
      email: "op@example.invalid",
      displayName: "Op",
    });
  });

  it("does not accept a cookie signed with the internal API token", () => {
    mocks.config.mockReturnValue({ operator: { sessionSecret }, api: { internalToken } });
    expect(getOperatorSessionFromRequest(requestWithCookie(forge(internalToken)))).toBeNull();
    expect(getOperatorSessionFromRequest(requestWithCookie(forge(sessionSecret)))).not.toBeNull();
  });

  it("has no session at all while the key is missing, whatever else the config holds", () => {
    mocks.config.mockReturnValue({
      api: { internalToken },
      registration: { intentEncryptionKey: "0".repeat(64) },
    });
    expect(() => setOperatorSessionCookie(NextResponse.json({}), {
      email: "op@example.invalid", displayName: "Op", expiresAt: buildOperatorSessionExpiresAt(), generation: 0,
    })).toThrow(/operator\.sessionSecret/u);
    expect(() => getOperatorSessionFromRequest(requestWithCookie(forge(internalToken))))
      .toThrow(/operator\.sessionSecret/u);
  });
});

/**
 * The cookie is stateless, so ending a session means changing what it is checked against: the
 * operator's session generation, which a logout counts up.
 */
describe("ending operator sessions", () => {
  const sessionSecret = "operator-only-secret";

  function signedIn(generation = 0) {
    const response = NextResponse.json({});
    setOperatorSessionCookie(response, {
      email: "op@example.invalid",
      displayName: "Op",
      expiresAt: buildOperatorSessionExpiresAt(),
      generation,
    });
    const value = response.cookies.get(OPERATOR_SESSION_COOKIE_NAME)!.value;
    return new NextRequest("https://server.test/api/operator/auth/refresh", {
      method: "POST",
      headers: { cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${value}` },
    });
  }

  beforeEach(() => {
    mocks.config.mockReturnValue({ operator: { sessionSecret } });
    mocks.runtime = { platformSuperUsers: [{ email: "op@example.invalid", passwordHash: "x" }] };
  });

  it("ends every session the operator holds when one of them logs out", () => {
    const here = signedIn();
    const copied = signedIn();
    expect(getOperatorSessionFromRequest(copied)).not.toBeNull();

    expect(endOperatorSessions("Op@Example.invalid")).toBe(true);
    expect(getOperatorSessionFromRequest(here)).toBeNull();
    expect(getOperatorSessionFromRequest(copied)).toBeNull();
    // A new login signs with the new generation and is good again.
    expect(getOperatorSessionFromRequest(signedIn(1))).not.toBeNull();
  });

  it("refuses an operator who was removed or disabled, without waiting for a refresh", () => {
    const request = signedIn();
    mocks.runtime = { platformSuperUsers: [{ email: "op@example.invalid", passwordHash: "x", enabled: false }] };
    expect(getOperatorSessionFromRequest(request)).toBeNull();
    mocks.runtime = { platformSuperUsers: [] };
    expect(getOperatorSessionFromRequest(request)).toBeNull();
  });

  it("refuses a cookie signed before sessions carried a generation", () => {
    const payload = Buffer.from(JSON.stringify({
      email: "op@example.invalid", displayName: "Op", expiresAt: Date.now() + 60_000,
    }), "utf8").toString("base64url");
    const value = `${payload}.${createHmac("sha256", sessionSecret).update(payload).digest("base64url")}`;
    expect(getOperatorSessionFromRequest(new NextRequest("https://server.test/x", {
      headers: { cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${value}` },
    }))).toBeNull();
  });
});
