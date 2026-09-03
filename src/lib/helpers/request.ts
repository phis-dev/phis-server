/**
 * Shared request-parsing helpers for route handlers.
 *
 * These existed as ~45 identical route-local copies before being consolidated; keep additions here
 * instead of re-declaring them per route, so parsing behavior cannot drift between endpoints.
 */

export function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** Reads a JSON object body; anything else — invalid JSON, arrays, primitives — yields `{}`. */
export async function readRequestBody(request: Request) {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parsePositiveInt(value: string | null | undefined) {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parsePositiveIntWithFallback(value: string | null | undefined, fallback: number) {
  return parsePositiveInt(value) ?? fallback;
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
