import "server-only";

import { NextResponse } from "next/server";

import { getPhisConfigSync } from "@/lib/config";
import { SESSION_COOKIE_NAME, sha256Hex } from "@/lib/auth";
import { readPhiClientIp } from "@/lib/helpers/request";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { PHIS_FORM_RELAY_HEADER, PHIS_TOKEN_HEADER } from "@/lib/constants/http-headers";

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

/** How many submissions a minute one visitor gets through the Site's form relay. */
export const FORM_RELAY_SUBMISSIONS_PER_MINUTE = 30;

function readCookieValue(request: Request, name: string) {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

/*
 * The visitor behind a relayed submission: their session where the relay forwarded one, else the
 * address a trusted proxy vouched for. Neither is there for an anonymous form behind no trusted hop, and
 * then nothing is counted here -- one shared bucket would lock every anonymous visitor out at once. The
 * credential routes (login, reset, register, contact) keep their own per-subject limits for that case.
 */
function readFormRelayVisitor(request: Request) {
  const session = readCookieValue(request, SESSION_COOKIE_NAME);
  if (session) {
    return `session:${sha256Hex(session).slice(0, 32)}`;
  }
  const address = readPhiClientIp(request);
  return address ? `address:${address}` : null;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/*
 * Whether a browser sent this write from somewhere other than the Site's own pages.
 *
 * `/api/site/*` authenticates by the session cookie alone, and SameSite=Lax still sends it from a
 * sibling subdomain; `request.json()` ignores the Content-Type, so a `text/plain` POST -- a simple
 * request, no preflight -- was read and acted on. The Site's proxy forwards what the browser said about
 * the request, so it is decided here: `Sec-Fetch-Site` where the browser sends it, which only
 * `same-origin` passes; else `Origin` against the host the Site forwarded for. Neither header is no
 * browser context -- the Site's own server-side calls, a CLI -- and nothing a CSRF page can make a
 * browser send.
 */
function isCrossOriginBrowserWrite(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite) {
    return fetchSite !== "same-origin";
  }
  const origin = request.headers.get("origin")?.trim();
  if (!origin) {
    return false;
  }
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))
    ?.trim()
    .toLowerCase();
  try {
    return origin === "null" || !host || new URL(origin).host.toLowerCase() !== host;
  } catch {
    return true;
  }
}

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

export async function guardApiV1(request: Request, options: GuardOptions = {}) {
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
  if (
    path.startsWith("/api/site/") &&
    WRITE_METHODS.has(request.method) &&
    isCrossOriginBrowserWrite(request)
  ) {
    return NextResponse.json({ error: "Cross-origin write refused." }, { status: 403 });
  }

  const config = getPhisConfigSync();
  const shouldRateLimit = tokenMode !== "internal" && config.api?.disableRateLimit !== true;

  /*
   * The internal token passes the per-address limit below, and the form relay holds it for every
   * visitor at once. What it marks as a visitor's submission is counted per visitor instead.
   */
  if (
    tokenMode === "internal" &&
    request.headers.get(PHIS_FORM_RELAY_HEADER) === "1" &&
    getPhisConfigSync().api?.disableRateLimit !== true
  ) {
    const visitor = readFormRelayVisitor(request);
    const retryAfter = visitor
      ? await checkRateLimit(`form-relay:${visitor}`, FORM_RELAY_SUBMISSIONS_PER_MINUTE)
      : null;
    if (retryAfter !== null) {
      return NextResponse.json(
        { error: "Too many requests." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  }

  if (shouldRateLimit) {
    /*
     * A path with its own allowance gets its own bucket. Sharing one would measure a generous path's
     * requests against a strict path's ceiling, and the refusal would land on whichever request came
     * next rather than on the one that was too many.
     */
    const limit = RATE_LIMIT_PER_MINUTE_BY_PATH[path];
    const retryAfter = limit == null
      ? await checkRateLimit(getClientIp(request))
      : await checkRateLimit(`${path}:${getClientIp(request)}`, limit);
    if (retryAfter !== null) {
      return NextResponse.json(
        { error: "Too many requests." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  }

  return null;
}
