import type { PhisPaymentDunningPolicy, PhisPaymentInterval } from "@phis/contracts/payments";
import { PhisPaymentError } from "./validation.ts";

/**
 * The arithmetic of a subscription's schedule, and nothing that touches a database or a Provider.
 *
 * Two rules carry everything else. A period boundary is computed from the start of the first period and
 * the number of periods since, never from the previous boundary or from the day a charge succeeded, so
 * neither a late charge nor a short month moves the schedule. And a retry is counted from the day the
 * period fell due, not from the previous attempt, so the time a customer is given does not depend on
 * how late a run happened to be.
 */

const DAY_MS = 86_400_000;
const MAX_COUNT: Readonly<Record<PhisPaymentInterval["unit"], number>> = { day: 366, week: 104, month: 36, year: 5 };
export const PHIS_PAYMENT_DUNNING_MAX_ATTEMPTS = 8;
export const PHIS_PAYMENT_DUNNING_MAX_DAYS = 60;

/** Where a consumer states no policy: three further attempts in the first week, then a person decides. */
export const PHIS_PAYMENT_DEFAULT_DUNNING: PhisPaymentDunningPolicy = Object.freeze({ retryAfterDays: Object.freeze([3, 5, 7]), onExhausted: "unpaid" });

export function validatePhisPaymentInterval(value: unknown): PhisPaymentInterval {
  const interval = value as PhisPaymentInterval | null;
  if (!interval || typeof interval !== "object" || !Object.hasOwn(MAX_COUNT, interval.unit)
    || !Number.isInteger(interval.count) || interval.count < 1 || interval.count > MAX_COUNT[interval.unit]) throw new PhisPaymentError("invalid_input");
  return { unit: interval.unit, count: interval.count };
}

export function validatePhisPaymentDunningPolicy(value: unknown): PhisPaymentDunningPolicy {
  if (value == null) return { retryAfterDays: [...PHIS_PAYMENT_DEFAULT_DUNNING.retryAfterDays], onExhausted: PHIS_PAYMENT_DEFAULT_DUNNING.onExhausted };
  const policy = value as PhisPaymentDunningPolicy;
  if (typeof policy !== "object" || !Array.isArray(policy.retryAfterDays) || policy.retryAfterDays.length > PHIS_PAYMENT_DUNNING_MAX_ATTEMPTS
    || (policy.onExhausted !== "unpaid" && policy.onExhausted !== "cancel")) throw new PhisPaymentError("invalid_input");
  let previous = 0;
  for (const days of policy.retryAfterDays) {
    // Strictly later each time: two attempts on one day are one attempt made twice.
    if (!Number.isInteger(days) || days <= previous || days > PHIS_PAYMENT_DUNNING_MAX_DAYS) throw new PhisPaymentError("invalid_input");
    previous = days;
  }
  return { retryAfterDays: [...policy.retryAfterDays], onExhausted: policy.onExhausted };
}

/**
 * The boundary `periods` intervals after the anchor, in UTC.
 *
 * Months and years keep the anchor's day where the target month has it and take its last day where it
 * does not, and they do so from the anchor each time: a contract begun on the 31st renews on the 30th of
 * a short month and on the 31st again after it.
 */
export function addPhisPaymentIntervals(anchor: Date, interval: PhisPaymentInterval, periods: number): Date {
  const steps = interval.count * periods;
  if (interval.unit === "day" || interval.unit === "week") {
    return new Date(anchor.getTime() + steps * (interval.unit === "week" ? 7 : 1) * DAY_MS);
  }
  const months = anchor.getUTCMonth() + steps * (interval.unit === "year" ? 12 : 1);
  const year = anchor.getUTCFullYear() + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(anchor.getUTCDate(), lastDay),
    anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
}

/**
 * When the next automatic attempt is owed, after `attempts` have been made for a period that fell due
 * at `dueAt`; `null` when the policy allows no further one.
 */
export function nextPhisPaymentDunningAttempt(dueAt: Date, policy: PhisPaymentDunningPolicy, attempts: number): Date | null {
  const days = policy.retryAfterDays[attempts - 1];
  return attempts >= 1 && days !== undefined ? new Date(dueAt.getTime() + days * DAY_MS) : null;
}

/**
 * How long a customer who has to return is waited for: until the last attempt would have been made. No
 * attempt is made in that time, because none can succeed without them.
 */
export function phisPaymentDunningDeadline(dueAt: Date, policy: PhisPaymentDunningPolicy): Date {
  return new Date(dueAt.getTime() + (policy.retryAfterDays.at(-1) ?? 0) * DAY_MS);
}
