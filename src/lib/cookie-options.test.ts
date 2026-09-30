import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextResponse } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/config", () => ({
  getPhisConfigSync: () => ({ operator: { sessionSecret: "test-operator-secret" } }),
}));

import {
  clearAreaCookie,
  clearAuthFlowCookie,
  clearAuthLinkCookie,
  clearCsrfCookie,
  clearSessionCookie,
  setAreaCookie,
  setAuthFlowCookie,
  setAuthLinkCookie,
  setCsrfCookie,
  setLocaleCookie,
  setSessionCookie,
  setThemeModeCookie,
} from "./auth";
import { clearOperatorSessionCookie, setOperatorSessionCookie } from "./operator-auth";

/**
 * Every cookie this server writes, with the attributes it is written with.
 *
 * The attributes used to stand beside each setter and now come from one builder; this pins what each
 * setter hands the browser, so a change to the builder shows up as the cookies it changes.
 */

function capture(write: (response: NextResponse) => void) {
  const set = vi.fn();
  write({ cookies: { set } } as unknown as NextResponse);
  expect(set).toHaveBeenCalledTimes(1);
  const [name, , options] = set.mock.calls[0]!;
  return { name, options };
}

const expiresAt = new Date(Date.UTC(2026, 9, 1));
const cleared = new Date(0);

describe("the cookies this server writes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["phis_session", (r: NextResponse) => setSessionCookie(r, "id", "secret", expiresAt), true, expiresAt],
    ["phis_session", clearSessionCookie, true, cleared],
    ["phis_auth_link", (r: NextResponse) => setAuthLinkCookie(r, "token", expiresAt), true, expiresAt],
    ["phis_auth_link", clearAuthLinkCookie, true, cleared],
    ["phis_auth_flow", (r: NextResponse) => setAuthFlowCookie(r, "state", expiresAt), true, expiresAt],
    ["phis_auth_flow", clearAuthFlowCookie, true, cleared],
    ["phis_csrf", (r: NextResponse) => setCsrfCookie(r, "token"), false, undefined],
    ["phis_csrf", clearCsrfCookie, false, cleared],
    ["phis_area", (r: NextResponse) => setAreaCookie(r, "admin", expiresAt), false, expiresAt],
    ["phis_area", (r: NextResponse) => setAreaCookie(r, "admin"), false, undefined],
    ["phis_area", clearAreaCookie, false, cleared],
    ["phis_theme_mode", (r: NextResponse) => setThemeModeCookie(r, "dark", expiresAt), false, expiresAt],
    ["phis_theme_mode", (r: NextResponse) => setThemeModeCookie(r, "system"), false, cleared],
    ["phis_locale", (r: NextResponse) => setLocaleCookie(r, "de", expiresAt), false, expiresAt],
    ["phis_locale", (r: NextResponse) => setLocaleCookie(r, "de"), false, undefined],
    [
      "phis_operator_session",
      (r: NextResponse) => setOperatorSessionCookie(r, { email: "a@b.c", displayName: "A", expiresAt }),
      true,
      expiresAt,
    ],
    ["phis_operator_session", clearOperatorSessionCookie, true, cleared],
  ] as const)("writes %s with its attributes", (cookieName, write, httpOnly, expires) => {
    const { name, options } = capture(write);
    expect(name).toBe(cookieName);
    expect(options).toEqual({
      httpOnly,
      sameSite: "lax",
      secure: false,
      path: "/",
      ...(expires ? { expires } : {}),
    });
  });

  it("marks every cookie secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(capture(clearCsrfCookie).options.secure).toBe(true);
    expect(capture((r) => setSessionCookie(r, "id", "secret", expiresAt)).options.secure).toBe(true);
    expect(capture(clearOperatorSessionCookie).options.secure).toBe(true);
  });
});
