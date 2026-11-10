import net from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePhisRedisReply } from "@/lib/cache/redis-client";
import type { PhisConfig } from "@/lib/config-core";

const mocks = vi.hoisted(() => ({ getPhisConfigSync: vi.fn(), logRuntimeEvent: vi.fn() }));

vi.mock("@/lib/config", () => ({ getPhisConfigSync: mocks.getPhisConfigSync }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: mocks.logRuntimeEvent }));

const { checkRateLimit, resetRateLimitsForTest } = await import("@/lib/rate-limit");

/** A cache that counts the way the script asks it to, and remembers what it was asked. */
async function startCountingCache() {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parsePhisRedisReply(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.next);
        const [command, , , key, windowMs] = (parsed.value as string[]).map(String);
        if (command !== "EVAL") {
          socket.write("-ERR unexpected\r\n");
          continue;
        }
        keys.push(key!);
        const count = (counts.get(key!) ?? 0) + 1;
        counts.set(key!, count);
        socket.write(`*2\r\n:${count}\r\n:${windowMs}\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `redis://127.0.0.1:${port}`,
    keys,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

describe("the rate limit", () => {
  let cache: Awaited<ReturnType<typeof startCountingCache>> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitsForTest();
    mocks.getPhisConfigSync.mockReturnValue({} as PhisConfig);
  });

  afterEach(async () => {
    resetRateLimitsForTest();
    await cache?.close();
    cache = null;
  });

  it("counts in the process where the installation names no cache", async () => {
    expect(await checkRateLimit("subject-a", 2, 60_000)).toBeNull();
    expect(await checkRateLimit("subject-a", 2, 60_000)).toBeNull();
    expect(await checkRateLimit("subject-a", 2, 60_000)).toBeGreaterThan(0);
    expect(await checkRateLimit("subject-b", 2, 60_000)).toBeNull();
    expect(mocks.logRuntimeEvent).not.toHaveBeenCalled();
  });

  it("counts in the shared cache where one is named, and answers with the window's remaining time", async () => {
    cache = await startCountingCache();
    mocks.getPhisConfigSync.mockReturnValue({ cache: { redisUrl: cache.url } } as PhisConfig);

    expect(await checkRateLimit("login:1:someone@example.test", 2, 90_000)).toBeNull();
    expect(await checkRateLimit("login:1:someone@example.test", 2, 90_000)).toBeNull();
    expect(await checkRateLimit("login:1:someone@example.test", 2, 90_000)).toBe(90);
    expect(cache.keys).toHaveLength(3);
  });

  it("gives the cache a digest of the subject, never the address or the email itself", async () => {
    cache = await startCountingCache();
    mocks.getPhisConfigSync.mockReturnValue({ cache: { redisUrl: cache.url } } as PhisConfig);

    await checkRateLimit("login:1:someone@example.test");

    expect(cache.keys[0]).toMatch(/^phis:rate:[0-9a-f]{40}$/);
    expect(cache.keys[0]).not.toContain("someone");
  });

  it("keeps counting in the process when the cache cannot be reached, and says so once", async () => {
    cache = await startCountingCache();
    const url = cache.url;
    await cache.close();
    cache = null;
    mocks.getPhisConfigSync.mockReturnValue({ cache: { redisUrl: url } } as PhisConfig);

    expect(await checkRateLimit("subject-c", 1, 60_000)).toBeNull();
    // Not open: the limit still holds. Not locked: the first attempt went through.
    expect(await checkRateLimit("subject-c", 1, 60_000)).toBeGreaterThan(0);
    expect(mocks.logRuntimeEvent).toHaveBeenCalledTimes(1);
    expect(mocks.logRuntimeEvent.mock.calls[0]?.[1]).toBe("rate-limit.cache.unavailable");
  });

  it("counts in the process when the configured address is not one", async () => {
    mocks.getPhisConfigSync.mockReturnValue({ cache: { redisUrl: "not an address" } } as PhisConfig);

    expect(await checkRateLimit("subject-d", 1, 60_000)).toBeNull();
    expect(await checkRateLimit("subject-d", 1, 60_000)).toBeGreaterThan(0);
  });
});
