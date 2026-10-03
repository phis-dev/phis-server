import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query }) }));

import { touchSession } from "./user-sessions";

/**
 * `last_seen_at` answers "last seen" in minutes. Written on every request it was an UPDATE on every
 * signed-in page view and every guarded call, so a request writes it only once it has gone stale.
 */
describe("touching a session", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");

  beforeEach(() => {
    query.mockReset().mockResolvedValue({ rows: [] });
  });

  it("writes nothing for a session seen a moment ago", async () => {
    await touchSession({ id: "s", lastSeenAt: new Date(now - 60_000).toISOString() }, now);
    expect(query).not.toHaveBeenCalled();
  });

  it("writes once the last write is five minutes old, or there is none", async () => {
    await touchSession({ id: "s", lastSeenAt: new Date(now - 5 * 60_000).toISOString() }, now);
    await touchSession({ id: "t", lastSeenAt: null }, now);
    expect(query.mock.calls.map(([config]) => config.values)).toEqual([["s"], ["t"]]);
  });
});
