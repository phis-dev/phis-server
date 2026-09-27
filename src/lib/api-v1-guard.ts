import "server-only";

import { NextResponse } from "next/server";

import { getPhisConfigSync } from "@/lib/config";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { PHIS_TOKEN_HEADER } from "@/lib/constants/http-headers";

const AUTH_HEADER = "authorization";

/**
 * The paths where 60 a minute is the wrong number, and what the right one is measuring.
 *
 * The default fits a page fetching its own data. `/api/v1/tr` is not that: it is a batch endpoint of up
 * to 50 messages, and its public caller is another installation asking a mirror for the platform's own
 * copy (TRANSLATIONS.md, "Translation modes"). A cold installation asks once per Label Set per register,
 * which is around seventy requests for one locale -- so a ceiling that cannot clear that in one sitting
 * shuts out precisely the caller a mirror exists for.
 *
 * It was exempt altogether until now, which was never a limit for anybody it applied to: the internal
 * token is already exempt one condition below, so the exemption only ever covered a public caller. The
 * README has described the intended behaviour the whole time.
 *
 * This bounds load, not spend. A public request reaches a provider only where
 * `translation.allowPublicWrites` is on, and with 50 texts to a batch no requests-per-minute figure is
 * a sensible ceiling on a bill -- that is the write flag's job, and the catalogue's.
 *
 * A caller refused here is not broken, it is on its own: the CDN step reads any non-2xx as "not held
 * there" and falls through to its own provider. A `429` therefore costs the caller money rather than an
 * error, which is why this number is generous rather than careful.
 */
const RATE_LIMIT_PER_MINUTE_BY_PATH: Record<string, number> = {
  "/api/v1/tr": 120,
};

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
  const shouldRateLimit = tokenMode !== "internal" && config.api?.disableRateLimit !== true;

  if (shouldRateLimit) {
    /*
     * A path with its own allowance gets its own bucket. Sharing one would measure a generous path's
     * requests against a strict path's ceiling, and the refusal would land on whichever request came
     * next rather than on the one that was too many.
     */
    const limit = RATE_LIMIT_PER_MINUTE_BY_PATH[path];
    const retryAfter = limit == null
      ? checkRateLimit(getClientIp(request))
      : checkRateLimit(`${path}:${getClientIp(request)}`, limit);
    if (retryAfter !== null) {
      return NextResponse.json(
        { error: "Too many requests." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  }

  return null;
}
