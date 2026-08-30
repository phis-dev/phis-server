import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";

import { getPhiServerConfigSync } from "@/lib/config";

export const OPERATOR_SESSION_COOKIE_NAME = "phi_operator_session";

const OPERATOR_SESSION_TTL_SECONDS = 60 * 30;

type OperatorSessionPayload = {
  email: string;
  displayName: string;
  expiresAt: number;
};

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function getOperatorSessionSecret() {
  const config = getPhiServerConfigSync();
  const secret =
    config.api?.internalToken?.trim() ||
    config.registration?.intentEncryptionKey?.trim() ||
    "";

  if (!secret) {
    throw new Error("Missing operator session signing secret in runtime config.");
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
    {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction(),
      path: "/",
      expires: input.expiresAt,
    },
  );
}

export function clearOperatorSessionCookie(response: NextResponse) {
  response.cookies.set(OPERATOR_SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    expires: new Date(0),
  });
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
