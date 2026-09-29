/**
 * Whether a value is a plain record: an object, not null, not an array.
 *
 * Eight modules kept this as a private function, each with the same body. One export so the answer is
 * chosen once; free of `server-only` because the CLI bundles modules that ask it.
 */
export function isPhiRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
