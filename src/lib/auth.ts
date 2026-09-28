import "server-only";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";

import { readPhiClientIp } from "@/lib/helpers/request";
import { resolveSiteLocale } from "@/lib/locale";
import type { PhiUserThemeModeName } from "@/lib/user-flags";

export const SESSION_COOKIE_NAME = "phis_session";
export const CSRF_COOKIE_NAME = "phis_csrf";
export const AREA_COOKIE_NAME = "phis_area";
/** Named here and read in phis-ui as `PHI_THEME_MODE_COOKIE`; the two have to agree. */
export const THEME_MODE_COOKIE_NAME = "phis_theme_mode";
/**
 * The language this browser is being read in. Written by the locale switch in phis-ui as well, which is
 * why the name is stated once here and read everywhere rather than spelled out at each cookie call.
 */
export const LOCALE_COOKIE_NAME = "phis_locale";
export const AUTH_LINK_COOKIE_NAME = "phis_auth_link";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

function isProduction() {
  return process.env.NODE_ENV === "production";
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(byteLength = 32) {
  return randomBytes(byteLength).toString("hex");
}

export function createSessionId() {
  return randomUUID();
}

export function createSessionSecret() {
  return randomToken(32);
}

export function createCsrfToken() {
  return randomToken(32);
}

export function buildSessionCookieValue(sessionId: string, sessionSecret: string) {
  return `${sessionId}.${sessionSecret}`;
}

/**
 * The shape `createSessionId` writes, which is also the shape `phis.user_sessions.id` stores.
 *
 * Reading the cookie has to state it, because the id goes straight into a `uuid` column and Postgres
 * refuses a value that is not one -- `22P02`, raised from the query rather than returned as an empty
 * result. An unreadable cookie is not a failed lookup that a caller can answer with "no session": it
 * is a thrown error, and it came back as a 500 from every route that asks who is signed in. Including
 * the Site locale resolution the Login page itself waits on, so the one page that could have replaced
 * the cookie was the one page that could not be reached.
 *
 * A cookie whose id cannot name a session is no session, and that is what this returns.
 */
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSessionCookieValue(value?: string | null) {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return null;
  }

  const dotIndex = raw.indexOf(".");
  if (dotIndex <= 0 || dotIndex === raw.length - 1) {
    return null;
  }

  const sessionId = raw.slice(0, dotIndex).trim();
  const sessionSecret = raw.slice(dotIndex + 1).trim();

  if (!sessionSecret || !SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }

  return { sessionId, sessionSecret };
}

export function verifySecretHash(secret: string, expectedHash: string) {
  const actual = Buffer.from(sha256Hex(secret), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

export function buildSessionExpiresAt() {
  return new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
}

/**
 * `sameSite: "lax"` is load-bearing for `/api/site`, and it is the only thing bearing it.
 *
 * Those routes verify no CSRF token -- `verifyCsrfRequest` guards `/api/v1/auth/*` and nothing else --
 * so what keeps a foreign page from writing in a signed-in visitor's name is this attribute plus the
 * absence of CORS headers. Together they hold: `Lax` withholds the cookie from a cross-site POST, and a
 * `PATCH` or a JSON body needs a preflight that no route answers. Nothing in the application takes part.
 *
 * So the day this becomes `none` -- an embedding, an iframe, a third-party surface asking for it -- the
 * 32 POST routes under `/api/site` lose their protection at once, and the request that reaches them may
 * change Site configuration. The check belongs in `requireSiteRoleApiContext`, which every one of them
 * already passes through; the work is on the calling side, where each writer has to send the header. Do
 * that first, not afterwards.
 */
export function setSessionCookie(response: NextResponse, sessionId: string, sessionSecret: string, expiresAt: Date) {
  response.cookies.set(SESSION_COOKIE_NAME, buildSessionCookieValue(sessionId, sessionSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    expires: new Date(0),
  });
}

export function setAuthLinkCookie(
  response: NextResponse,
  token: string,
  expiresAt: Date,
) {
  response.cookies.set(AUTH_LINK_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    expires: expiresAt,
  });
}

export function clearAuthLinkCookie(response: NextResponse) {
  response.cookies.set(AUTH_LINK_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    expires: new Date(0),
  });
}

export function setCsrfCookie(response: NextResponse, csrfToken: string) {
  response.cookies.set(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
  });
}

export function clearCsrfCookie(response: NextResponse) {
  response.cookies.set(CSRF_COOKIE_NAME, "", {
    httpOnly: false,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    expires: new Date(0),
  });
}

export function setAreaCookie(response: NextResponse, area: string, expiresAt?: Date) {
  response.cookies.set(AREA_COOKIE_NAME, area.trim().toLowerCase(), {
    httpOnly: false,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    ...(expiresAt ? { expires: expiresAt } : {}),
  });
}

export function clearAreaCookie(response: NextResponse) {
  response.cookies.set(AREA_COOKIE_NAME, "", {
    httpOnly: false,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    expires: new Date(0),
  });
}

/**
 * The account's Theme choice, mirrored where readers without a session can see it.
 *
 * Two of them cannot ask who is asking: the static proxy picks a render before any session is
 * resolved, and the script that runs before the first paint has none either. So the choice travels in
 * the request, the way `phis_locale` does -- the account remains where it is decided.
 *
 * `system` is the absence of a choice and clears the cookie rather than writing a third value. That
 * also matters on a browser this person has not used before: a stale cookie would otherwise outvote an
 * account that has since withdrawn its choice.
 */
export function setThemeModeCookie(
  response: NextResponse,
  themeMode: PhiUserThemeModeName,
  expiresAt?: Date,
) {
  if (themeMode === "system") {
    response.cookies.set(THEME_MODE_COOKIE_NAME, "", {
      httpOnly: false,
      sameSite: "lax",
      secure: isProduction(),
      path: "/",
      expires: new Date(0),
    });
    return;
  }
  response.cookies.set(THEME_MODE_COOKIE_NAME, themeMode, {
    httpOnly: false,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    ...(expiresAt ? { expires: expiresAt } : {}),
  });
}

/**
 * The language a signed-in person is served, and the one rule every sign-in follows.
 *
 * A saved choice wins. Where there is none, what this browser is already being read in wins -- the
 * locale cookie the visitor wrote by picking a language in the Public Area, then their browser's own
 * preference, then the Site default. `preferred_locale` is `NULL` for an account that has never answered
 * the question, and that absence is the whole switch: nothing else may write the column, so a value
 * there is always somebody's answer.
 *
 * Sign-in used to resolve from `preferred_locale` alone and then overwrite the locale cookie with the
 * result, so a visitor who read the Public pages in German and then signed in was handed the Site
 * default by an account that had never been asked. The cookie is written from this answer afterwards, so
 * carrying the choice through costs nothing further -- it is already there.
 */
export function resolveSignedInLocale(
  request: NextRequest,
  input: {
    user: { preferredLocale?: string | null } | null | undefined;
    defaultLocale: string;
    availableLocales: readonly string[];
  },
) {
  return resolveSiteLocale({
    userPreferredLocale: input.user?.preferredLocale ?? null,
    cookieLocale: request.cookies.get(LOCALE_COOKIE_NAME)?.value ?? null,
    browserLocale: request.headers.get("accept-language"),
    defaultLocale: input.defaultLocale,
    availableLocales: input.availableLocales,
  }).locale;
}

export function setLocaleCookie(response: NextResponse, locale: string, expiresAt?: Date) {
  response.cookies.set(LOCALE_COOKIE_NAME, locale, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    ...(expiresAt ? { expires: expiresAt } : {}),
  });
}

export function readRequestIp(request: NextRequest) {
  return readPhiClientIp(request);
}

export function readRequestUserAgent(request: NextRequest) {
  const userAgent = request.headers.get("user-agent")?.trim() ?? "";
  return userAgent || null;
}

export function verifyCsrfRequest(request: NextRequest) {
  const headerToken = request.headers.get("x-csrf-token")?.trim() ?? "";
  const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value?.trim() ?? "";
  return Boolean(headerToken && cookieToken && headerToken === cookieToken);
}
