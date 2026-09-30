/**
 * Whether a stored expiry has been reached.
 *
 * An expiry that does not parse counts as reached. The token it guards is refused rather than honoured
 * forever: a date nobody can read is broken input, and treating it as "not yet" would turn a damaged
 * row into a token that never expires.
 */
export function hasExpiryPassed(expiresAt: string, now = Date.now()) {
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= now;
}
