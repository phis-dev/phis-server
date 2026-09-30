import { describe, expect, it } from "vitest";

import { hasExpiryPassed } from "@/lib/helpers/expiry";

describe("hasExpiryPassed", () => {
  const now = Date.parse("2026-09-30T12:00:00.000Z");

  it("is reached once the moment has come", () => {
    expect(hasExpiryPassed("2026-09-30T11:59:59.000Z", now)).toBe(true);
    expect(hasExpiryPassed("2026-09-30T12:00:00.000Z", now)).toBe(true);
  });

  it("is not reached while the moment lies ahead", () => {
    expect(hasExpiryPassed("2026-09-30T12:00:01.000Z", now)).toBe(false);
  });

  it("counts an expiry that does not parse as reached", () => {
    expect(hasExpiryPassed("", now)).toBe(true);
    expect(hasExpiryPassed("not a date", now)).toBe(true);
  });
});
