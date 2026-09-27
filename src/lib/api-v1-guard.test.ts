import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PhisConfig } from "@/lib/config-core";

const mocks = vi.hoisted(() => ({ getPhisConfigSync: vi.fn() }));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getPhisConfigSync: mocks.getPhisConfigSync,
}));

const { guardApiV1 } = await import("@/lib/api-v1-guard");

/*
 * The limit a public caller meets, and the one it must not meet.
 *
 * `/api/v1/tr` was exempt from the rate limit, and the exemption only ever reached a public caller: the
 * internal token is exempt a condition earlier. So the endpoint a mirror answers the world with was the
 * one with no ceiling at all, while the README said every request without internal scope had one.
 *
 * The buckets are process state, so every case here asks from an address of its own.
 */
describe("the rate limit of a public caller", () => {
  const CONFIG = { api: { internalToken: "internal-token", publicToken: "public-token" } };

  const ask = (path: string, token: string, ip: string) => guardApiV1(
    new Request(`https://core.test${path}`, {
      method: "POST",
      headers: { "x-phis-token": token, "user-agent": "phis-server/test", "x-forwarded-for": ip },
    }),
  );

  const askRepeatedly = (path: string, token: string, ip: string, times: number) =>
    Array.from({ length: times }, () => ask(path, token, ip));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TRUST_PROXY", "1");
    mocks.getPhisConfigSync.mockReturnValue(CONFIG as PhisConfig);
  });

  it("lets a cold installation warm a locale before it refuses one", () => {
    const answers = askRepeatedly("/api/v1/tr", "public-token", "203.0.113.1", 120);

    expect(answers.every((answer) => answer === null)).toBe(true);

    const refused = ask("/api/v1/tr", "public-token", "203.0.113.1");
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("Retry-After")).toBeTruthy();
  });

  it("refuses an ordinary path sixty requests earlier", () => {
    const answers = askRepeatedly("/api/v1/site", "public-token", "203.0.113.2", 60);

    expect(answers.every((answer) => answer === null)).toBe(true);
    expect(ask("/api/v1/site", "public-token", "203.0.113.2")?.status).toBe(429);
  });

  it("keeps the batch endpoint's allowance out of every other path's bucket", () => {
    // Seventy is a locale's worth of Label Sets, and it is also over the ordinary ceiling. Sharing one
    // bucket, the next request to any other path would be refused for requests it never made.
    askRepeatedly("/api/v1/tr", "public-token", "203.0.113.3", 70);

    expect(ask("/api/v1/site", "public-token", "203.0.113.3")).toBeNull();
  });

  it("does not count the internal caller at all", () => {
    const answers = askRepeatedly("/api/v1/tr", "internal-token", "203.0.113.4", 200);

    expect(answers.every((answer) => answer === null)).toBe(true);
  });
});
