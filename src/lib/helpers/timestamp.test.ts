import { describe, expect, it } from "vitest";

import { toPhiIsoString } from "./timestamp";

describe("a timestamp column as an ISO string", () => {
  it("answers null for an empty column", () => {
    expect(toPhiIsoString(null)).toBeNull();
    expect(toPhiIsoString(undefined)).toBeNull();
    expect(toPhiIsoString("")).toBeNull();
  });

  it("writes a Date as ISO", () => {
    expect(toPhiIsoString(new Date(Date.UTC(2026, 8, 30, 12, 0, 0)))).toBe("2026-09-30T12:00:00.000Z");
  });

  it("rewrites Postgres' own text form rather than passing it through", () => {
    expect(toPhiIsoString("2026-09-30 14:00:00+02")).toBe("2026-09-30T12:00:00.000Z");
  });
});
