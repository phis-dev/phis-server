import { describe, expect, it } from "vitest";

import { AUTH_ATTEMPTS_PER_MINUTE, checkAuthAttemptLimit } from "./attempt-limit";

function request(headers: Record<string, string> = {}) {
  return { headers: new Headers(headers) };
}

describe("checkAuthAttemptLimit", () => {
  it("lets the allowance through and refuses the guess after it, per subject", async () => {
    const key = `login:1:${Math.random()}`;
    for (let attempt = 0; attempt < AUTH_ATTEMPTS_PER_MINUTE; attempt += 1) {
      expect(await checkAuthAttemptLimit(request(), [key])).toBeNull();
    }
    expect(await checkAuthAttemptLimit(request(), [key])).toBeGreaterThan(0);
    // Another subject is another bucket: one account under attack does not lock the next one.
    expect(await checkAuthAttemptLimit(request(), [`login:1:${Math.random()}`])).toBeNull();
  });

  it("does not share one bucket among everybody when no address is known", async () => {
    const first = `verify:${Math.random()}`;
    const second = `verify:${Math.random()}`;
    for (let attempt = 0; attempt < AUTH_ATTEMPTS_PER_MINUTE; attempt += 1) {
      await checkAuthAttemptLimit(request(), [first]);
    }
    expect(await checkAuthAttemptLimit(request(), [first])).toBeGreaterThan(0);
    expect(await checkAuthAttemptLimit(request(), [second])).toBeNull();
  });
});
