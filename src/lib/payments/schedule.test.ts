import { describe, expect, it } from "vitest";

import {
  PHIS_PAYMENT_DEFAULT_DUNNING, addPhisPaymentIntervals, nextPhisPaymentDunningAttempt, phisPaymentDunningDeadline,
  validatePhisPaymentDunningPolicy, validatePhisPaymentInterval,
} from "./schedule.ts";

const at = (iso: string) => new Date(iso);
const iso = (date: Date | null) => date?.toISOString() ?? null;

describe("period boundaries", () => {
  it("counts every boundary from the anchor, so a short month does not shorten the ones after it", () => {
    const anchor = at("2026-01-31T10:15:00.000Z");
    const monthly = { unit: "month", count: 1 } as const;

    expect(iso(addPhisPaymentIntervals(anchor, monthly, 1))).toBe("2026-02-28T10:15:00.000Z");
    // Counted from the previous boundary this would be the 28th for ever after.
    expect(iso(addPhisPaymentIntervals(anchor, monthly, 2))).toBe("2026-03-31T10:15:00.000Z");
    expect(iso(addPhisPaymentIntervals(anchor, monthly, 3))).toBe("2026-04-30T10:15:00.000Z");
    expect(iso(addPhisPaymentIntervals(anchor, monthly, 12))).toBe("2027-01-31T10:15:00.000Z");
  });

  it("takes a quarter as three months and a year across a leap day", () => {
    expect(iso(addPhisPaymentIntervals(at("2026-11-30T00:00:00.000Z"), { unit: "month", count: 3 }, 1))).toBe("2027-02-28T00:00:00.000Z");
    expect(iso(addPhisPaymentIntervals(at("2028-02-29T08:00:00.000Z"), { unit: "year", count: 1 }, 1))).toBe("2029-02-28T08:00:00.000Z");
    expect(iso(addPhisPaymentIntervals(at("2028-02-29T08:00:00.000Z"), { unit: "year", count: 1 }, 4))).toBe("2032-02-29T08:00:00.000Z");
  });

  it("counts days and weeks as elapsed time", () => {
    expect(iso(addPhisPaymentIntervals(at("2026-03-28T23:30:00.000Z"), { unit: "day", count: 10 }, 2))).toBe("2026-04-17T23:30:00.000Z");
    expect(iso(addPhisPaymentIntervals(at("2026-03-28T23:30:00.000Z"), { unit: "week", count: 2 }, 3))).toBe("2026-05-09T23:30:00.000Z");
  });

  it("refuses an interval that is not one", () => {
    expect(validatePhisPaymentInterval({ unit: "month", count: 3 })).toEqual({ unit: "month", count: 3 });
    for (const bad of [null, {}, { unit: "month", count: 0 }, { unit: "month", count: 1.5 }, { unit: "decade", count: 1 }, { unit: "year", count: 6 }]) {
      expect(() => validatePhisPaymentInterval(bad)).toThrow();
    }
  });
});

describe("the dunning policy", () => {
  const due = at("2026-06-01T00:00:00.000Z");

  it("counts every retry from the day the period fell due, not from the attempt before", () => {
    const policy = { retryAfterDays: [3, 5, 7], onExhausted: "unpaid" } as const;

    // Nothing is owed before the first charge was made at all.
    expect(nextPhisPaymentDunningAttempt(due, policy, 0)).toBeNull();
    expect(iso(nextPhisPaymentDunningAttempt(due, policy, 1))).toBe("2026-06-04T00:00:00.000Z");
    expect(iso(nextPhisPaymentDunningAttempt(due, policy, 2))).toBe("2026-06-06T00:00:00.000Z");
    expect(iso(nextPhisPaymentDunningAttempt(due, policy, 3))).toBe("2026-06-08T00:00:00.000Z");
    // The first charge and three retries: after the fourth failure nothing more is tried.
    expect(nextPhisPaymentDunningAttempt(due, policy, 4)).toBeNull();
  });

  it("waits for a customer as long as it would have kept trying", () => {
    expect(iso(phisPaymentDunningDeadline(due, { retryAfterDays: [3, 5, 7], onExhausted: "unpaid" }))).toBe("2026-06-08T00:00:00.000Z");
    // A policy without retries gives no time either.
    expect(iso(phisPaymentDunningDeadline(due, { retryAfterDays: [], onExhausted: "cancel" }))).toBe("2026-06-01T00:00:00.000Z");
  });

  it("gives the default where none is stated, and a copy of it", () => {
    const policy = validatePhisPaymentDunningPolicy(null);
    expect(policy).toEqual({ retryAfterDays: [3, 5, 7], onExhausted: "unpaid" });
    expect(policy.retryAfterDays).not.toBe(PHIS_PAYMENT_DEFAULT_DUNNING.retryAfterDays);
    expect(validatePhisPaymentDunningPolicy({ retryAfterDays: [], onExhausted: "cancel" })).toEqual({ retryAfterDays: [], onExhausted: "cancel" });
  });

  it("refuses retries that are out of order, on one day, too many or too late", () => {
    const bad = [
      { retryAfterDays: [5, 3], onExhausted: "unpaid" },
      { retryAfterDays: [3, 3], onExhausted: "unpaid" },
      { retryAfterDays: [0], onExhausted: "unpaid" },
      { retryAfterDays: [61], onExhausted: "unpaid" },
      { retryAfterDays: [1, 2, 3, 4, 5, 6, 7, 8, 9], onExhausted: "unpaid" },
      { retryAfterDays: [3], onExhausted: "forgive" },
      { retryAfterDays: "3", onExhausted: "unpaid" },
    ];
    for (const policy of bad) expect(() => validatePhisPaymentDunningPolicy(policy)).toThrow();
  });
});
