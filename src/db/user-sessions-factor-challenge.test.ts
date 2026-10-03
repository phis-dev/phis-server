import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hasFactorChallengeLapsed } from "./user-sessions";
import { FACTOR_CHALLENGE_TTL_SECONDS } from "@/lib/auth";
import { PHI_AUTH_SESSION_STATES } from "@/lib/site-auth/contracts";

/**
 * A session that holds the password and waits for the code is good for trying codes and nothing else,
 * so it lives minutes, not the two weeks a signed-in session does.
 */
describe("a session waiting for its second factor", () => {
  const began = Date.parse("2026-10-03T12:00:00Z");
  const challenge = { authState: PHI_AUTH_SESSION_STATES.factorChallengeRequired, authenticatedAt: new Date(began).toISOString() };

  it("is good within the window", () => {
    expect(hasFactorChallengeLapsed(challenge, began + (FACTOR_CHALLENGE_TTL_SECONDS - 1) * 1000)).toBe(false);
  });

  it("lapses when the window is over", () => {
    expect(hasFactorChallengeLapsed(challenge, began + FACTOR_CHALLENGE_TTL_SECONDS * 1000)).toBe(true);
  });

  it("lapses when nothing says when the wait began", () => {
    expect(hasFactorChallengeLapsed({ ...challenge, authenticatedAt: null }, began)).toBe(true);
  });

  it("does not touch a signed-in session or one setting up its factor", () => {
    const later = began + 14 * 24 * 3600 * 1000 - 1;
    expect(hasFactorChallengeLapsed({ ...challenge, authState: PHI_AUTH_SESSION_STATES.complete }, later)).toBe(false);
    expect(hasFactorChallengeLapsed(
      { ...challenge, authState: PHI_AUTH_SESSION_STATES.factorEnrollmentRequired },
      later,
    )).toBe(false);
  });
});
