import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";

import { getPhisConfigSync } from "@/lib/config";
import { buildPhiClearedCookieOptions, buildPhiCookieOptions } from "@/lib/cookie-options";

export const OPERATOR_SESSION_COOKIE_NAME = "phis_operator_session";

const OPERATOR_SESSION_TTL_SECONDS = 60 * 30;

type OperatorSessionPayload = {
  email: string;
  displayName: string;
  expiresAt: number;
};

/**
 * The dedicated key, or nothing. The internal API token stood in for it before, with the registration
 * key as a second fallback, and both are held by parties that must not be able to sign an operator in:
 * every Site runtime carries the internal token. There is no fallback now; an installation without the
 * key has no operator sessions until `phis operator add` or the setup finish writes one.
 */
function getOperatorSessionSecret() {
  const secret = getPhisConfigSync().operator?.sessionSecret?.trim() ?? "";
  if (!secret) {
    throw new Error(
      "Missing operator.sessionSecret in runtime config; `phis operator add` or the setup finish writes it.",
    );
  }
  return secret;
}

function toBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signOperatorSessionPayload(payload: string) {
  return createHmac("sha256", getOperatorSessionSecret()).update(payload).digest("base64url");
}

function buildOperatorSessionValue(payload: OperatorSessionPayload) {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signOperatorSessionPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function parseOperatorSessionValue(rawValue?: string | null) {
  const value = rawValue?.trim() ?? "";
  if (!value) {
    return null;
  }

  const dotIndex = value.indexOf(".");
  if (dotIndex <= 0 || dotIndex === value.length - 1) {
    return null;
  }

  const encodedPayload = value.slice(0, dotIndex);
  const signature = value.slice(dotIndex + 1);
  const expectedSignature = signOperatorSessionPayload(encodedPayload);
  const actual = Buffer.from(signature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload)) as OperatorSessionPayload;
    if (!payload.email?.trim() || !payload.displayName?.trim() || !payload.expiresAt) {
      return null;
    }
    if (payload.expiresAt <= Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function buildOperatorSessionExpiresAt() {
  return new Date(Date.now() + OPERATOR_SESSION_TTL_SECONDS * 1000);
}

export function setOperatorSessionCookie(
  response: NextResponse,
  input: { email: string; displayName: string; expiresAt: Date },
) {
  response.cookies.set(
    OPERATOR_SESSION_COOKIE_NAME,
    buildOperatorSessionValue({
      email: input.email.trim().toLowerCase(),
      displayName: input.displayName.trim(),
      expiresAt: input.expiresAt.getTime(),
    }),
    buildPhiCookieOptions({ httpOnly: true, expires: input.expiresAt }),
  );
}

export function clearOperatorSessionCookie(response: NextResponse) {
  response.cookies.set(
    OPERATOR_SESSION_COOKIE_NAME,
    "",
    buildPhiClearedCookieOptions({ httpOnly: true }),
  );
}

export function getOperatorSessionFromRequest(request: NextRequest) {
  return parseOperatorSessionValue(
    request.cookies.get(OPERATOR_SESSION_COOKIE_NAME)?.value ?? null,
  );
}

export async function getOperatorSession() {
  const cookieStore = await cookies();
  return parseOperatorSessionValue(
    cookieStore.get(OPERATOR_SESSION_COOKIE_NAME)?.value ?? null,
  );
}
