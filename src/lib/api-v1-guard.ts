import "server-only";

import { NextResponse } from "next/server";

import { getPhisConfigSync } from "@/lib/config";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { PHIS_TOKEN_HEADER } from "@/lib/constants/http-headers";

const AUTH_HEADER = "authorization";
const NO_RATE_LIMIT_PATHS = new Set(["/api/v1/tr"]);

type GuardOptions = {
  requireInternalToken?: boolean;
  allowMissingToken?: boolean;
};

export type ApiV1TokenMode = "internal" | "public" | null;

function getPublicToken() {
  return getPhisConfigSync().api?.publicToken?.trim() ?? "";
}

function getInternalToken() {
  return getPhisConfigSync().api?.internalToken?.trim() ?? "";
}

function readProvidedToken(request: Request) {
  const tokenFromHeader = request.headers.get(PHIS_TOKEN_HEADER);
  const tokenFromAuth = request.headers.get(AUTH_HEADER);
  const authMatch =
    tokenFromAuth?.toLowerCase().startsWith("bearer ") ? tokenFromAuth.slice(7).trim() : "";

  return tokenFromHeader || authMatch || "";
}

export function getApiV1TokenMode(request: Request): ApiV1TokenMode {
  const providedToken = readProvidedToken(request);
  if (!providedToken) {
    return null;
  }

  if (providedToken === getInternalToken()) {
    return "internal";
  }

  if (providedToken === getPublicToken()) {
    return "public";
  }

  return null;
}

export function guardApiV1(request: Request, options: GuardOptions = {}) {
  const tokenMode = getApiV1TokenMode(request);

  if (
    options.requireInternalToken
      ? tokenMode !== "internal"
      : !options.allowMissingToken && tokenMode === null
  ) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const userAgent = request.headers.get("user-agent") ?? "";
  if (!userAgent.trim()) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const ua = userAgent.toLowerCase();
  if (/(bot|crawler|spider|scrapy|slurp|duckduckbot|bingbot|yandex|baiduspider)/.test(ua)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const path = new URL(request.url).pathname;
  const config = getPhisConfigSync();
  const shouldRateLimit =
    tokenMode !== "internal" &&
    config.api?.disableRateLimit !== true &&
    !NO_RATE_LIMIT_PATHS.has(path);

  if (shouldRateLimit) {
    const retryAfter = checkRateLimit(getClientIp(request));
    if (retryAfter !== null) {
      return NextResponse.json(
        { error: "Too many requests." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  }

  return null;
}
