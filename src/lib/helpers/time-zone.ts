/**
 * An IANA time zone name as the runtime knows it, or null for anything else.
 *
 * `Intl` is the judge: it accepts what the ICU data of this Node knows, which is what the browsers
 * know too, and it answers the canonical spelling -- `europe/berlin` comes back as `Europe/Berlin`,
 * `UTC` stays `UTC`. The Site's zone is stored in that spelling so that the server and every browser
 * format with the same name.
 */
export function normalizePhiTimeZone(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat("en", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
