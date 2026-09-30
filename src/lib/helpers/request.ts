/**
 * Shared request-parsing helpers for route handlers.
 *
 * These existed as ~45 identical route-local copies before being consolidated; keep additions here
 * instead of re-declaring them per route, so parsing behavior cannot drift between endpoints.
 */

import { NextResponse } from "next/server";

import { isPhiRecord } from "./record";

export function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** A trimmed string, or null where nothing but whitespace -- or no string at all -- was sent. */
export function normalizeNullableString(value: unknown) {
  return normalizeString(value) || null;
}

/**
 * A whole number as a JSON body or a query string carries it, or null for anything else.
 *
 * Signed, because status and kind codes are not ids; a string has to be the number and nothing more,
 * so `"12abc"` is refused instead of being read as 12.
 */
export function normalizeNullableInteger(value: unknown) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== "string" || !/^-?\d+$/u.test(value.trim())) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * The positive ids of a submitted list, each read as `parseStrictPositiveInt` reads one.
 *
 * Numbers and digit strings alike: a declared Form's Select holds strings, a client holding ids sends
 * numbers, and both reach the same routes. Entries that are neither are dropped, as the lists were
 * always filtered rather than refused.
 */
export function normalizePositiveIdArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((entry) => parseStrictPositiveInt(entry))
        .filter((entry): entry is number => entry !== null)
    : [];
}

/**
 * Reads a JSON object body, or null for anything else: invalid JSON, an array, a primitive.
 *
 * For the routes that refuse such a body rather than reading it as empty; `readRequestBody` below is
 * the lenient twin for the routes whose every field is optional.
 */
export async function readJsonObjectBody(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    return isPhiRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * A JSON object body, or the 400 that refuses anything else.
 *
 * Nine routes wrote this guard by hand, with the same condition and their own wording; the wording is
 * still theirs to give.
 */
export async function requireJsonObjectBody(request: Request, error = "Invalid JSON body.") {
  const body = await readJsonObjectBody(request);
  if (!body) {
    return { ok: false as const, response: NextResponse.json({ error }, { status: 400 }) };
  }
  return { ok: true as const, body };
}

/** Reads a JSON object body; anything else — invalid JSON, arrays, primitives — yields `{}`. */
export async function readRequestBody(request: Request) {
  return (await readJsonObjectBody(request)) ?? {};
}

/**
 * Whether a request was sent by a page of this origin.
 *
 * For the few routes that act without a session -- the setup surface runs before any operator exists --
 * and would otherwise take a cross-site form POST, which a browser sends without a preflight.
 * `Sec-Fetch-Site` answers it where the browser sends it, which every current one does; without it the
 * `Origin` header has to name the host the request was addressed to. A request with neither is refused:
 * a browser always sends one of them on a POST, and a script that sends none is not a page of ours.
 */
export function isSameOriginRequest(request: { headers: Headers }) {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite) {
    return fetchSite === "same-origin";
  }
  const origin = request.headers.get("origin")?.trim();
  const host = request.headers.get("host")?.trim().toLowerCase();
  if (!origin || !host || origin === "null") {
    return false;
  }
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

export function parsePositiveInt(value: string | null | undefined) {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * A positive integer id and nothing near it: `"12abc"`, `"1.5"`, `-3` and `0` are refused rather than
 * cut down to something that names another row.
 */
export function parseStrictPositiveInt(value: unknown) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parsePositiveIntWithFallback(value: string | null | undefined, fallback: number) {
  return parsePositiveInt(value) ?? fallback;
}

/** The page size a list answers with when the caller names none. */
export const PHI_DEFAULT_PAGE_SIZE = 25;

/** The most rows one page of a list may ask for, whatever the caller names. */
export const PHI_MAX_PAGE_SIZE = 100;

/**
 * `page` and `pageSize` from a list's query string: one-based, positive, and capped at
 * `PHI_MAX_PAGE_SIZE`. Five list routes carried the same two lines with the same two numbers in them.
 */
export function parsePhiPagination(
  searchParams: URLSearchParams,
  defaultPageSize: number = PHI_DEFAULT_PAGE_SIZE,
) {
  return {
    page: parsePositiveIntWithFallback(searchParams.get("page"), 1),
    pageSize: Math.min(
      parsePositiveIntWithFallback(searchParams.get("pageSize"), defaultPageSize),
      PHI_MAX_PAGE_SIZE,
    ),
  };
}

/**
 * How many proxies in front of this process are ours.
 *
 * `X-Forwarded-For` is a list every hop appends to, so the entries an untrusted caller wrote and the
 * entries our own infrastructure observed sit in the same header, indistinguishable by shape. Only the
 * count tells them apart: the rightmost `n` were written by the `n` proxies we run, and the one before
 * them is the address the outermost of those actually saw.
 *
 * Named after the Express convention, and the value the shipped `.env` templates carry. Absent, it is
 * read as one, which is what the nginx profile this ships with builds: a caller who removed the
 * variable rather than setting it to `0` should not silently get a stricter answer than the
 * installation they were given.
 */
function resolveTrustedProxyHops() {
  const raw = process.env.TRUST_PROXY?.trim().toLowerCase() ?? "";
  if (raw === "false" || raw === "0") {
    return 0;
  }
  if (!raw || raw === "true") {
    return 1;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * The address the request actually came from, as far as anything here can know it.
 *
 * `X-Forwarded-For` first, because it is the header every reverse proxy writes -- `X-Real-IP` is an
 * nginx convention, and an installation behind Traefik, HAProxy or a CDN would not have one at all.
 *
 * Counted from the right rather than read from the left. The first entry is the one usually taken for
 * "the client" and is exactly the one a caller can invent: nginx's `$proxy_add_x_forwarded_for`, and
 * every other proxy's equivalent, appends to what arrived rather than replacing it. Skipping our own
 * hops from the end lands on the address the outermost proxy we run observed, which no caller can
 * write past.
 *
 * With no trusted proxy the header says nothing at all and is ignored -- behind nothing, every one of
 * these values is the caller's to invent, and that is answered by where the process listens rather
 * than here.
 *
 * Used for rate-limit keys and for the address recorded against a session, so the difference is not
 * cosmetic: reading the first entry lets one caller appear as an unlimited number of them.
 */
export function readPhiClientIp(request: { headers: Headers }) {
  const hops = resolveTrustedProxyHops();
  if (hops === 0) {
    return null;
  }

  const forwarded = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // A chain shorter than the hops we claim is not a shorter chain: it is a request that did not come
  // the way we think, so nothing in it has been vouched for.
  const observed = forwarded.length >= hops ? forwarded[forwarded.length - hops] : undefined;
  if (observed) {
    return observed;
  }

  // Only where the list is absent: a proxy that sets this and no `X-Forwarded-For` still overwrites it
  // per request, so it is the caller's only where there is no proxy -- the case ruled out above.
  return request.headers.get("x-real-ip")?.trim() || null;
}
