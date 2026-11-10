import { createHash } from "node:crypto";

import { createPhisRedisClient, type PhisRedisClient } from "@/lib/cache/redis-client";
import { getPhisConfigSync } from "@/lib/config";
import { readPhiClientIp } from "@/lib/helpers/request";
import { logRuntimeEvent } from "@/lib/log";

/**
 * How often one subject may do one thing in a window of time.
 *
 * The count lives in one of two places. Where the installation names a shared cache (`cache.redisUrl`)
 * every Core instance counts in it, so the limit is the limit however many instances answer. Where it
 * names none, or the cache cannot be reached, this process counts by itself -- which is exact for one
 * instance and, for several, a limit that is too generous rather than a door that is locked or open.
 * An unreachable cache is therefore never a reason to refuse a request and never a reason to stop
 * counting.
 */

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const RATE_LIMITS = new Map<string, RateLimitEntry>();
const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;
const MAX_TRACKED = 10_000;

function makeRoom(now: number) {
  if (RATE_LIMITS.size < MAX_TRACKED) {
    return;
  }
  for (const [key, entry] of RATE_LIMITS) {
    if (entry.resetAt <= now) {
      RATE_LIMITS.delete(key);
    }
  }
  /*
   * Still full: every key is inside its window, which is what a flood of distinct keys looks like. The
   * oldest are let go. A subject forgotten this way starts a fresh window, which is the lesser harm
   * beside a map that grows for as long as the flood lasts.
   */
  for (const key of RATE_LIMITS.keys()) {
    if (RATE_LIMITS.size < MAX_TRACKED) break;
    RATE_LIMITS.delete(key);
  }
}

function countInProcess(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  makeRoom(now);

  const entry = RATE_LIMITS.get(key);
  if (!entry || entry.resetAt <= now) {
    // Deleted first so the key moves to the young end of the map, which is the order `makeRoom` trusts.
    RATE_LIMITS.delete(key);
    RATE_LIMITS.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }

  if (entry.count >= limit) {
    return Math.ceil((entry.resetAt - now) / 1000);
  }

  entry.count += 1;
  return null;
}

/*
 * One round trip, and atomic: the count and the lifetime of the window are set together, so two
 * instances that see a key for the first time cannot both believe they opened its window. A key that
 * has lost its lifetime is given one again instead of counting forever.
 */
const COUNT_SCRIPT = [
  "local count = redis.call('INCR', KEYS[1])",
  "local ttl = redis.call('PTTL', KEYS[1])",
  "if ttl < 0 then",
  "  redis.call('PEXPIRE', KEYS[1], ARGV[1])",
  "  ttl = tonumber(ARGV[1])",
  "end",
  "return {count, ttl}",
].join("\n");

let shared: { url: string; client: PhisRedisClient } | null = null;
let lastFailureLoggedAt = 0;

function readSharedClient() {
  const url = getPhisConfigSync().cache?.redisUrl?.trim() ?? "";
  if (!url) {
    shared?.client.close();
    shared = null;
    return null;
  }
  if (shared?.url !== url) {
    shared?.client.close();
    shared = { url, client: createPhisRedisClient(url) };
  }
  return shared.client;
}

async function countInSharedCache(client: PhisRedisClient, key: string, limit: number, windowMs: number) {
  // The key names a person or an address; the cache is shared, so it gets a digest of it instead.
  const name = `phis:rate:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
  const reply = await client.command(["EVAL", COUNT_SCRIPT, 1, name, windowMs]);
  if (!Array.isArray(reply) || typeof reply[0] !== "number" || typeof reply[1] !== "number") {
    throw new Error("The cache answered the count with something else.");
  }
  const [count, ttlMs] = reply;
  return count > limit ? Math.max(1, Math.ceil(ttlMs / 1000)) : null;
}

function noteSharedCacheFailure(error: unknown) {
  const now = Date.now();
  if (now - lastFailureLoggedAt < 60_000) return;
  lastFailureLoggedAt = now;
  logRuntimeEvent("warn", "rate-limit.cache.unavailable", {
    message: `Counting in this process instead: ${error instanceof Error ? error.message : String(error)}`,
  });
}

export function getClientIp(request: Request) {
  // "unknown" is a bucket, not an address: without one, every unattributable caller would otherwise
  // get a key of its own, which is the same as having no limit for exactly those callers.
  return readPhiClientIp(request) ?? "unknown";
}

/** Seconds until the subject may try again, or null when this attempt is within the limit. */
export async function checkRateLimit(
  key: string,
  limit = DEFAULT_LIMIT,
  windowMs = DEFAULT_WINDOW_MS,
): Promise<number | null> {
  let client: PhisRedisClient | null = null;
  try {
    client = readSharedClient();
  } catch (error) {
    noteSharedCacheFailure(error);
  }
  if (client) {
    try {
      return await countInSharedCache(client, key, limit, windowMs);
    } catch (error) {
      noteSharedCacheFailure(error);
    }
  }
  return countInProcess(key, limit, windowMs);
}

/** For tests: forget every count and the shared client. */
export function resetRateLimitsForTest() {
  RATE_LIMITS.clear();
  shared?.client.close();
  shared = null;
  lastFailureLoggedAt = 0;
}
