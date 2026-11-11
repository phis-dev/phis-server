import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] })));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query }) }));

import { flushPhiTranslationUse, notePhiTranslationUse } from "./translation-usage";

/*
 * Once per message and day: a second read the same day writes nothing, a new day writes again, and the
 * statement only ever moves a date forward.
 */

describe("translation usage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
    query.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a message read today once, per store", async () => {
    notePhiTranslationUse("global", [1, 2, 2]);
    notePhiTranslationUse("site", [7]);
    notePhiTranslationUse("global", [1]);
    await flushPhiTranslationUse();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toContain("phis.tr_msg_usage");
    expect(query.mock.calls[0]![1]).toEqual([[1, 2]]);
    expect(query.mock.calls[1]![0]).toContain("phis.tr_site_msg_usage");
    expect(query.mock.calls[1]![1]).toEqual([[7]]);

    query.mockClear();
    notePhiTranslationUse("global", [1, 2]);
    await flushPhiTranslationUse();
    expect(query).not.toHaveBeenCalled();
  });

  it("writes it again the next day, and only moves the date forward", async () => {
    notePhiTranslationUse("global", [11]);
    await flushPhiTranslationUse();
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    query.mockClear();
    notePhiTranslationUse("global", [11]);
    await flushPhiTranslationUse();
    expect(query.mock.calls[0]![1]).toEqual([[11]]);
    expect(query.mock.calls[0]![0]).toContain("WHERE phis.tr_msg_usage.last_used_on < EXCLUDED.last_used_on");
  });

  it("writes by itself a minute after the first new read", async () => {
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
    notePhiTranslationUse("site", [21]);
    expect(query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
