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
    Promise.all(Array.from({ length: times }, () => ask(path, token, ip)));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TRUST_PROXY", "1");
    mocks.getPhisConfigSync.mockReturnValue(CONFIG as PhisConfig);
  });

  it("lets a cold installation warm a locale before it refuses one", async () => {
    const answers = await askRepeatedly("/api/v1/tr", "public-token", "203.0.113.1", 120);

    expect(answers.every((answer) => answer === null)).toBe(true);

    const refused = await ask("/api/v1/tr", "public-token", "203.0.113.1");
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("Retry-After")).toBeTruthy();
  });

  it("refuses an ordinary path sixty requests earlier", async () => {
    const answers = await askRepeatedly("/api/v1/site", "public-token", "203.0.113.2", 60);

    expect(answers.every((answer) => answer === null)).toBe(true);
    expect((await ask("/api/v1/site", "public-token", "203.0.113.2"))?.status).toBe(429);
  });

  it("keeps the batch endpoint's allowance out of every other path's bucket", async () => {
    // Seventy is a locale's worth of Label Sets, and it is also over the ordinary ceiling. Sharing one
    // bucket, the next request to any other path would be refused for requests it never made.
    await askRepeatedly("/api/v1/tr", "public-token", "203.0.113.3", 70);

    expect(await ask("/api/v1/site", "public-token", "203.0.113.3")).toBeNull();
  });

  it("does not count the internal caller at all", async () => {
    const answers = await askRepeatedly("/api/v1/tr", "internal-token", "203.0.113.4", 200);

    expect(answers.every((answer) => answer === null)).toBe(true);
  });
});

/*
 * The form relay holds the internal token for every visitor of a Site, so what it marks as a visitor's
 * submission is counted per visitor -- and nothing else it sends is.
 */
describe("the limit on relayed form submissions", () => {
  const CONFIG = { api: { internalToken: "internal-token", publicToken: "public-token" } };

  const relay = (headers: Record<string, string>) => guardApiV1(
    new Request("https://core.test/api/site/threads/messages", {
      method: "POST",
      headers: { "x-phis-token": "internal-token", "user-agent": "phis-ui/test", ...headers },
    }),
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TRUST_PROXY", "1");
    mocks.getPhisConfigSync.mockReturnValue(CONFIG as PhisConfig);
  });

  it("counts one session's submissions and refuses the thirty-first in a minute", async () => {
    const visitor = { "x-phis-form-relay": "1", cookie: "phis_session=session-a; other=1" };
    const answers = await Promise.all(Array.from({ length: 30 }, () => relay(visitor)));
    expect(answers.every((answer) => answer === null)).toBe(true);

    const refused = await relay(visitor);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("Retry-After")).toBeTruthy();
    // Another visitor of the same Site is not affected.
    expect(await relay({ "x-phis-form-relay": "1", cookie: "phis_session=session-b" })).toBeNull();
  });

  it("counts an anonymous visitor by the address a trusted proxy names", async () => {
    const visitor = { "x-phis-form-relay": "1", "x-forwarded-for": "198.51.100.7" };
    await Promise.all(Array.from({ length: 30 }, () => relay(visitor)));
    expect((await relay(visitor))?.status).toBe(429);
  });

  it("leaves the Site runtime's own internal requests alone", async () => {
    const answers = await Promise.all(Array.from({ length: 100 }, () => relay({ cookie: "phis_session=session-c" })));
    expect(answers.every((answer) => answer === null)).toBe(true);
  });
});

/*
 * `/api/site/*` authenticates by the session cookie, so a write is only taken from the Site's own pages:
 * what the browser says about where it came from, forwarded by the Site's proxy, decides.
 */
describe("cross-origin writes to /api/site", () => {
  const CONFIG = { api: { internalToken: "internal-token", publicToken: "public-token" } };

  const write = (headers: Record<string, string>, method = "POST", path = "/api/site/groups") => guardApiV1(
    new Request(`https://core.test${path}`, {
      method,
      headers: { "x-phis-token": "internal-token", "user-agent": "phis-ui/test", ...headers },
    }),
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPhisConfigSync.mockReturnValue(CONFIG as PhisConfig);
  });

  it("takes a write the browser marks as same-origin", async () => {
    expect(await write({ "sec-fetch-site": "same-origin" })).toBeNull();
  });

  it("refuses one from a sibling subdomain or another site", async () => {
    expect((await write({ "sec-fetch-site": "same-site" }))?.status).toBe(403);
    expect((await write({ "sec-fetch-site": "cross-site" }, "DELETE"))?.status).toBe(403);
  });

  it("falls back to the Origin against the host the Site forwarded for", async () => {
    const forwarded = { "x-forwarded-host": "site.test" };
    expect(await write({ ...forwarded, origin: "https://site.test" })).toBeNull();
    expect((await write({ ...forwarded, origin: "https://evil.site.test" }))?.status).toBe(403);
    expect((await write({ ...forwarded, origin: "null" }))?.status).toBe(403);
  });

  it("leaves requests without a browser context, reads and other paths alone", async () => {
    expect(await write({})).toBeNull();
    expect(await write({ "sec-fetch-site": "cross-site" }, "GET")).toBeNull();
    expect(await write({ "sec-fetch-site": "cross-site" }, "POST", "/api/v1/tr")).toBeNull();
  });
});
