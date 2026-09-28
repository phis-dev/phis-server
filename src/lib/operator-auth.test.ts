import { createHmac } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: vi.fn() }));

vi.mock("@/lib/config", () => ({ getPhisConfigSync: mocks.config }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import {
  buildOperatorSessionExpiresAt,
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
    }), "utf8").toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  }

  beforeEach(() => {
    mocks.config.mockReset();
  });

  it("signs and reads back with the dedicated key", () => {
    mocks.config.mockReturnValue({ operator: { sessionSecret }, api: { internalToken } });
    const response = NextResponse.json({});
    setOperatorSessionCookie(response, {
      email: "Op@Example.invalid",
      displayName: "Op",
      expiresAt: buildOperatorSessionExpiresAt(),
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
      email: "op@example.invalid", displayName: "Op", expiresAt: buildOperatorSessionExpiresAt(),
    })).toThrow(/operator\.sessionSecret/u);
    expect(() => getOperatorSessionFromRequest(requestWithCookie(forge(internalToken))))
      .toThrow(/operator\.sessionSecret/u);
  });
});
