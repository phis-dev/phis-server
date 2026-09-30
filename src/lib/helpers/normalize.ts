/**
 * The spellings under which Sites and accounts are stored and looked up.
 *
 * Each stood as a private copy beside every query that needed it. A lookup normalized one way against a
 * row written another way finds nothing, so these are shared rather than merely alike. Free of
 * `server-only`: the CLI writes the same rows.
 */

/** An email address as accounts, intents and Sites store it: trimmed, lower case. */
export function normalizePhiEmail(value: string) {
  return value.trim().toLowerCase();
}

/** A Site key as it is looked up: trimmed, lower case, and nothing else changed. */
export function normalizePhiSiteKey(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * A Site key made from what an operator typed into a form: every run of other characters becomes one
 * hyphen, and hyphens at either end are dropped.
 *
 * Only for creating a Site. A key being looked up is normalized, never rewritten, or a typo would name
 * a different Site instead of none.
 */
export function slugifyPhiSiteKey(value: string) {
  return normalizePhiSiteKey(value)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Whether a value has the shape of an email address: something, an `@`, and a domain with a dot.
 *
 * Deliberately loose -- the mail that follows is the real check -- but one shape, so an address one form
 * takes is not refused by the next. Five handlers kept the pattern, two spellings of the same one.
 */
export function isPhiEmailAddress(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}
