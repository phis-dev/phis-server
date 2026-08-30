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
