import type { PhisConfig } from "./config-core.ts";

/**
 * The setup pages as a time window.
 *
 * `/setup` has no login: whoever reaches it can name the database, create the first operator and decide
 * what the installation serves. A permanent switch for that is one forgotten edit away from an open door,
 * so the setup is open only until a moment written into `bootstrap.enabledUntil` (ISO 8601, UTC) of
 * `config/phis-runtime.json`. Missing, unreadable or past means closed; there is no "on" without an end.
 *
 * `phis setup enable [--for 30m]` writes the moment, `phis setup disable` and the setup's finish step remove
 * it. A fresh Debian install opens one window by itself (`postinst`); every later one is asked for.
 *
 * Pure, so the CLI can use it; the server reads the window through `readPhiBootstrapWindowSync` in
 * `config.ts`.
 */

/** What `phis setup enable` gives without `--for`. */
export const PHI_BOOTSTRAP_WINDOW_DEFAULT_MS = 60 * 60 * 1000;

/**
 * The longest window there is. A moment further away than this is not honoured at all -- read as closed --
 * because nothing writes one but a hand edit, and a hand edit that opens the setup for a week is the
 * permanent switch again.
 */
export const PHI_BOOTSTRAP_WINDOW_MAX_MS = 4 * 60 * 60 * 1000;

/** Leeway for the clock of the machine that wrote the moment, against the one reading it. */
const CLOCK_SKEW_MS = 60 * 1000;

export type PhiBootstrapWindow =
  | { state: "open"; until: Date; remainingMs: number }
  | { state: "closed"; reason: "unset" | "expired" | "invalid" | "too-far"; until: Date | null };

/** `30m`, `1h`, `90s`, `1h30m`; a bare number is minutes. */
export function parsePhiBootstrapWindowDuration(value: string): number {
  const text = value.trim().toLowerCase();
  if (/^\d+$/u.test(text)) {
    return Number(text) * 60 * 1000;
  }
  const pattern = /(\d+)\s*(h|m|s)/gu;
  let total = 0;
  let consumed = "";
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]);
    total += amount * (match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1000);
    consumed += match[0];
  }
  if (!total || consumed.replace(/\s+/gu, "") !== text.replace(/\s+/gu, "")) {
    throw new Error(`"${value}" is not a duration. Use for example 30m, 1h or 1h30m.`);
  }
  return total;
}

/** The moment a window opened now for `durationMs` closes, held to the longest window there is. */
export function resolvePhiBootstrapWindowEnd(durationMs: number, now = Date.now()) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("A setup window needs a duration greater than zero.");
  }
  if (durationMs > PHI_BOOTSTRAP_WINDOW_MAX_MS) {
    throw new Error(`A setup window is at most ${PHI_BOOTSTRAP_WINDOW_MAX_MS / 3_600_000} hours.`);
  }
  return new Date(now + durationMs);
}

export function describePhiBootstrapWindow(config: Pick<PhisConfig, "bootstrap">, now = Date.now()): PhiBootstrapWindow {
  const raw = config.bootstrap?.enabledUntil;
  if (raw === undefined || raw === null || raw === "") {
    return { state: "closed", reason: "unset", until: null };
  }
  const until = typeof raw === "string" ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(until.getTime())) {
    return { state: "closed", reason: "invalid", until: null };
  }
  if (until.getTime() <= now) {
    return { state: "closed", reason: "expired", until };
  }
  if (until.getTime() - now > PHI_BOOTSTRAP_WINDOW_MAX_MS + CLOCK_SKEW_MS) {
    return { state: "closed", reason: "too-far", until };
  }
  return { state: "open", until, remainingMs: until.getTime() - now };
}
