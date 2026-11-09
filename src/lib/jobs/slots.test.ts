import { describe, expect, it } from "vitest";

import { isPhiJobStepSubHourly, resolvePhiJobSlot, resolvePhiJobStepMs } from "./slots";

/**
 * The moments a schedule names are the scheduler's whole coordination: every instance has to compute
 * the same one from the same clock, or the unique key on the ledger coordinates nothing.
 */
describe("the latest moment of a schedule", () => {
  const now = new Date("2026-11-09T09:17:42.000Z"); // a Monday

  it("falls on the clock for the short steps and the hour", () => {
    expect(resolvePhiJobSlot({ every: "5m" }, now).toISOString()).toBe("2026-11-09T09:15:00.000Z");
    expect(resolvePhiJobSlot({ every: "15m" }, now).toISOString()).toBe("2026-11-09T09:15:00.000Z");
    expect(resolvePhiJobSlot({ every: "30m" }, now).toISOString()).toBe("2026-11-09T09:00:00.000Z");
    expect(resolvePhiJobSlot({ every: "hourly" }, now).toISOString()).toBe("2026-11-09T09:00:00.000Z");
  });

  it("is the same moment on the clock's edge and one millisecond after it", () => {
    const edge = new Date("2026-11-09T09:15:00.000Z");
    expect(resolvePhiJobSlot({ every: "5m" }, edge).toISOString()).toBe("2026-11-09T09:15:00.000Z");
    expect(resolvePhiJobSlot({ every: "5m" }, new Date(edge.getTime() + 1)).toISOString()).toBe("2026-11-09T09:15:00.000Z");
    expect(resolvePhiJobSlot({ every: "5m" }, new Date(edge.getTime() - 1)).toISOString()).toBe("2026-11-09T09:10:00.000Z");
  });

  it("takes today's time of day for a daily step, or yesterday's when it is still ahead", () => {
    expect(resolvePhiJobSlot({ every: "daily", at: "04:15" }, now).toISOString()).toBe("2026-11-09T04:15:00.000Z");
    expect(resolvePhiJobSlot({ every: "daily", at: "23:30" }, now).toISOString()).toBe("2026-11-08T23:30:00.000Z");
    expect(resolvePhiJobSlot({ every: "daily" }, now).toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });

  it("walks back to the weekday for a weekly step, Monday unless said otherwise", () => {
    expect(resolvePhiJobSlot({ every: "weekly", at: "06:00" }, now).toISOString()).toBe("2026-11-09T06:00:00.000Z");
    expect(resolvePhiJobSlot({ every: "weekly", at: "12:00" }, now).toISOString()).toBe("2026-11-02T12:00:00.000Z");
    expect(resolvePhiJobSlot({ every: "weekly", weekday: 7 }, now).toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(resolvePhiJobSlot({ every: "weekly", weekday: 2, at: "08:00" }, now).toISOString()).toBe("2026-11-03T08:00:00.000Z");
  });

  it("names the steps shorter than an hour, whose runs are kept a day", () => {
    expect(isPhiJobStepSubHourly("5m")).toBe(true);
    expect(isPhiJobStepSubHourly("30m")).toBe(true);
    expect(isPhiJobStepSubHourly("hourly")).toBe(false);
    expect(resolvePhiJobStepMs("weekly")).toBe(7 * 24 * 60 * 60_000);
  });
});
