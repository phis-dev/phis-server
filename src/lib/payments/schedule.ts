import type { PhisPaymentDunningPolicy, PhisPaymentInterval } from "@phis/contracts/payments";
import { PhisPaymentError } from "./validation.ts";

/**
 * The arithmetic of a subscription's schedule, and nothing that touches a database or a Provider.
 *
 * Two rules carry everything else. A period boundary is computed from the start of the current term and
 * the number of periods since it began, never from the previous boundary or from the day a charge succeeded, so
 * neither a late charge nor a short month moves the schedule. And a retry is counted from the day the
 * period fell due, not from the previous attempt, so the time a customer is given does not depend on
 * how late a run happened to be. A period still unpaid when the subscription's grace ends has failed,
 * and the subscription with it, in every collection mode.
 */

const DAY_MS = 86_400_000;
const MAX_COUNT: Readonly<Record<PhisPaymentInterval["unit"], number>> = { day: 366, week: 104, month: 36, year: 5 };
export const PHIS_PAYMENT_DUNNING_MAX_ATTEMPTS = 8;
/** The longest grace and the longest lead a subscription may have, in whole days. */
export const PHIS_PAYMENT_GRACE_MAX_DAYS = 30;
export const PHIS_PAYMENT_LEAD_MAX_DAYS = 30;
/** How many days before a requested period's end the customer is reminded (`moment: "reminder"`). */
export const PHIS_PAYMENT_REMINDER_DAYS = 3;

/** The shortest a period of this interval can be, in whole days: what a lead or a grace has to stay below. */
export function shortestPhisPaymentPeriodDays(interval: PhisPaymentInterval): number {
  return interval.count * { day: 1, week: 7, month: 28, year: 365 }[interval.unit];
}

/** The longest a period of this interval can be, in whole days: what a declared `maxDays` has to reach. */
export function longestPhisPaymentPeriodDays(interval: PhisPaymentInterval): number {
  return interval.count * { day: 1, week: 7, month: 31, year: 366 }[interval.unit];
}

export function validatePhisPaymentInterval(value: unknown): PhisPaymentInterval {
  const interval = value as PhisPaymentInterval | null;
  if (!interval || typeof interval !== "object" || !Object.hasOwn(MAX_COUNT, interval.unit)
    || !Number.isInteger(interval.count) || interval.count < 1 || interval.count > MAX_COUNT[interval.unit]) throw new PhisPaymentError("invalid_input");
  return { unit: interval.unit, count: interval.count };
}

/** A grace or a lead: whole days from 0 to 30, and less than the shortest period of the interval. */
export function validatePhisPaymentDays(value: unknown, interval: PhisPaymentInterval, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max || (value as number) >= shortestPhisPaymentPeriodDays(interval)) {
    throw new PhisPaymentError("invalid_input");
  }
  return value as number;
}

/**
 * What a consumer asks after a declined renewal under `automatic`: further attempts, each a whole number of
 * days after the period fell due, strictly later each time, at most eight, and none past the grace -- the
 * grace is where the subscription ends, so an attempt after it could only charge a subscription that is gone.
 */
export function validatePhisPaymentDunningPolicy(value: unknown, graceDays: number): PhisPaymentDunningPolicy {
  const policy = value as PhisPaymentDunningPolicy;
  if (!policy || typeof policy !== "object" || Object.keys(policy).some(key => key !== "retryAfterDays")
    || !Array.isArray(policy.retryAfterDays) || policy.retryAfterDays.length > PHIS_PAYMENT_DUNNING_MAX_ATTEMPTS) throw new PhisPaymentError("invalid_input");
  let previous = 0;
  for (const days of policy.retryAfterDays) {
    // Strictly later each time: two attempts on one day are one attempt made twice.
    if (!Number.isInteger(days) || days <= previous || days > graceDays) throw new PhisPaymentError("invalid_input");
    previous = days;
  }
  return { retryAfterDays: [...policy.retryAfterDays] };
}

/** A whole number of days after an instant. */
export function addPhisPaymentDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
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
 * The unused share of a paid period at `at` (PAYMENTS.md, changes): `floor(R * (end - at) / (end - start))`,
 * by whole seconds and rounded down, in the customer's favour. Nothing before the start is unused twice and
 * nothing after the end is unused at all.
 */
export function phisPaymentUnusedShare(paid: bigint, start: Date, end: Date, at: Date): bigint {
  const total = BigInt(Math.floor((end.getTime() - start.getTime()) / 1000));
  const left = BigInt(Math.floor((end.getTime() - Math.max(at.getTime(), start.getTime())) / 1000));
  if (total <= BigInt(0) || left <= BigInt(0) || paid <= BigInt(0)) return BigInt(0);
  return (paid * (left < total ? left : total)) / total;
}
