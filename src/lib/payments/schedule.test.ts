import { describe, expect, it } from "vitest";

import {
  addPhisPaymentIntervals, nextPhisPaymentDunningAttempt, phisPaymentUnusedShare, validatePhisPaymentDays,
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
    const policy = { retryAfterDays: [3, 5, 7] } as const;

    // Nothing is owed before the first charge was made at all.
    expect(nextPhisPaymentDunningAttempt(due, policy, 0)).toBeNull();
    expect(iso(nextPhisPaymentDunningAttempt(due, policy, 1))).toBe("2026-06-04T00:00:00.000Z");
    expect(iso(nextPhisPaymentDunningAttempt(due, policy, 2))).toBe("2026-06-06T00:00:00.000Z");
    expect(iso(nextPhisPaymentDunningAttempt(due, policy, 3))).toBe("2026-06-08T00:00:00.000Z");
    // The first charge and three retries: after the fourth failure nothing more is tried.
    expect(nextPhisPaymentDunningAttempt(due, policy, 4)).toBeNull();
  });

  it("takes a policy whose retries lie within the grace, and a copy of it", () => {
    const stated = { retryAfterDays: [3, 5, 7] };
    const policy = validatePhisPaymentDunningPolicy(stated, 7);
    expect(policy).toEqual({ retryAfterDays: [3, 5, 7] });
    expect(policy.retryAfterDays).not.toBe(stated.retryAfterDays);
    // With a grace of 0 there is nothing to retry in.
    expect(validatePhisPaymentDunningPolicy({ retryAfterDays: [] }, 0)).toEqual({ retryAfterDays: [] });
  });

  it("refuses retries that are out of order, on one day, too many, past the grace or shaped otherwise", () => {
    const bad = [
      { retryAfterDays: [5, 3] },
      { retryAfterDays: [3, 3] },
      { retryAfterDays: [0] },
      { retryAfterDays: [15] },
      { retryAfterDays: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      { retryAfterDays: [3], onExhausted: "unpaid" },
      { retryAfterDays: "3" },
      null,
    ];
    for (const policy of bad) expect(() => validatePhisPaymentDunningPolicy(policy, 14)).toThrow();
    expect(() => validatePhisPaymentDunningPolicy({ retryAfterDays: [3] }, 2)).toThrow();
  });
});

describe("lead and grace", () => {
  it("are whole days from 0 to 30 and less than the shortest period", () => {
    expect(validatePhisPaymentDays(14, { unit: "year", count: 1 }, 30)).toBe(14);
    expect(validatePhisPaymentDays(0, { unit: "day", count: 1 }, 30)).toBe(0);
    for (const [days, interval] of [[31, { unit: "year", count: 1 }], [-1, { unit: "month", count: 1 }], [1.5, { unit: "month", count: 1 }],
      [28, { unit: "month", count: 1 }], [7, { unit: "week", count: 1 }], [1, { unit: "day", count: 1 }]] as const) {
      expect(() => validatePhisPaymentDays(days, interval, 30)).toThrow();
    }
    expect(validatePhisPaymentDays(27, { unit: "month", count: 1 }, 30)).toBe(27);
  });
});

describe("the unused share of a paid period", () => {
  it("is floor(R * (end - at) / (end - start)) by the second, rounded down (PLANS 7.3)", () => {
    // PhiVoice: EUR 4.99 for 1 Nov to 1 Dec, switched on 16 Nov 12:00 -- 14.5 of 30 days unused.
    expect(phisPaymentUnusedShare(BigInt(499), at("2026-11-01T00:00:00Z"), at("2026-12-01T00:00:00Z"), at("2026-11-16T12:00:00Z"))).toBe(BigInt(241));
    // Hosting: CHF 27.00 for 1 Oct to 1 Jan (92 days), switched on 1 Dec -- 31 days unused.
    expect(phisPaymentUnusedShare(BigInt(2700), at("2026-10-01T00:00:00Z"), at("2027-01-01T00:00:00Z"), at("2026-12-01T00:00:00Z"))).toBe(BigInt(909));
  });

  it("is the whole amount before the start and nothing at or after the end", () => {
    const start = at("2026-11-01T00:00:00Z"); const end = at("2026-12-01T00:00:00Z");
    expect(phisPaymentUnusedShare(BigInt(499), start, end, at("2026-10-20T00:00:00Z"))).toBe(BigInt(499));
    expect(phisPaymentUnusedShare(BigInt(499), start, end, end)).toBe(BigInt(0));
    expect(phisPaymentUnusedShare(BigInt(499), start, end, at("2026-12-02T00:00:00Z"))).toBe(BigInt(0));
    expect(phisPaymentUnusedShare(BigInt(0), start, end, at("2026-11-10T00:00:00Z"))).toBe(BigInt(0));
  });
});
