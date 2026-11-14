import { describe, expect, it } from "vitest";

import {
  describePhiBootstrapWindow,
  parsePhiBootstrapWindowDuration,
  PHI_BOOTSTRAP_WINDOW_MAX_MS,
  resolvePhiBootstrapWindowEnd,
} from "./bootstrap-window";

const NOW = Date.parse("2026-11-14T12:00:00Z");

describe("setup window", () => {
  it("reads durations", () => {
    expect(parsePhiBootstrapWindowDuration("30m")).toBe(30 * 60_000);
    expect(parsePhiBootstrapWindowDuration("1h30m")).toBe(90 * 60_000);
    expect(parsePhiBootstrapWindowDuration("45")).toBe(45 * 60_000);
    expect(() => parsePhiBootstrapWindowDuration("soon")).toThrow(/not a duration/);
    expect(() => parsePhiBootstrapWindowDuration("1h fortnight")).toThrow(/not a duration/);
  });

  it("refuses a window longer than the longest there is", () => {
    expect(() => resolvePhiBootstrapWindowEnd(PHI_BOOTSTRAP_WINDOW_MAX_MS + 1, NOW)).toThrow(/at most/);
    expect(resolvePhiBootstrapWindowEnd(60_000, NOW).toISOString()).toBe("2026-11-14T12:01:00.000Z");
  });

  it("is open only before its end and never without one", () => {
    expect(describePhiBootstrapWindow({}, NOW)).toEqual({ state: "closed", reason: "unset", until: null });
    expect(describePhiBootstrapWindow({ bootstrap: { enabledUntil: "tomorrow" } }, NOW).state).toBe("closed");
    expect(describePhiBootstrapWindow({ bootstrap: { enabledUntil: "2026-11-14T11:59:00Z" } }, NOW))
      .toMatchObject({ state: "closed", reason: "expired" });
    expect(describePhiBootstrapWindow({ bootstrap: { enabledUntil: "2026-11-14T12:30:00Z" } }, NOW))
      .toMatchObject({ state: "open", remainingMs: 30 * 60_000 });
  });

  it("does not honour a hand-written end far in the future", () => {
    expect(describePhiBootstrapWindow({ bootstrap: { enabledUntil: "2026-11-21T12:00:00Z" } }, NOW))
      .toMatchObject({ state: "closed", reason: "too-far" });
  });
});
