import { describe, expect, it } from "vitest";

import { PhiGroupMembershipFlags, readPhiGroupMembershipFlags } from "./site-groups";

/**
 * What a request may say about a membership level. Anything outside the four levels is a bad request,
 * answered as one -- it used to reach the normalizer and come back as a 500.
 */
describe("a membership level read from a request", () => {
  it("takes the four levels, cumulative or not", () => {
    const { Member, Manager } = PhiGroupMembershipFlags;
    expect(readPhiGroupMembershipFlags(Member)).toBe(Member);
    expect(readPhiGroupMembershipFlags(Manager)).toBe(Manager);
    expect(readPhiGroupMembershipFlags(4)).toBe(PhiGroupMembershipFlags.Editor);
  });

  it("answers null for anything else instead of throwing", () => {
    for (const value of [0, -1, 99, 1.5, Number.NaN, "2", null, undefined]) {
      expect(readPhiGroupMembershipFlags(value)).toBeNull();
    }
  });
});
