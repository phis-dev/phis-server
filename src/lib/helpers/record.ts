/**
 * Whether a value is a plain record: an object, not null, not an array.
 *
 * Eight modules kept this as a private function, each with the same body. One export so the answer is
 * chosen once; free of `server-only` because the CLI bundles modules that ask it.
 */
export function isPhiRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The value as a plain record, or an empty one for anything else -- an array, a primitive, null.
 *
 * What a JSON column or a submitted field is read as when only an object means something. Kept as a
 * private `toJsonRecord`/`normalizeJsonRecord` in a dozen modules, one of which passed arrays through.
 */
export function toPhiRecord(value: unknown): Record<string, unknown> {
  return isPhiRecord(value) ? value : {};
}
