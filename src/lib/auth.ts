import "server-only";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";

import { readPhiClientIp } from "@/lib/helpers/request";

export const SESSION_COOKIE_NAME = "phis_session";
export const CSRF_COOKIE_NAME = "phis_csrf";
export const AREA_COOKIE_NAME = "phis_area";
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
