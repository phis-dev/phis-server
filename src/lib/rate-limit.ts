type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const RATE_LIMITS = new Map<string, RateLimitEntry>();
const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;
const MAX_TRACKED = 10_000;

function cleanupOldEntries(now: number) {
  if (RATE_LIMITS.size < MAX_TRACKED) {
    return;
  }

  for (const [key, entry] of RATE_LIMITS) {
    if (entry.resetAt <= now) {
      RATE_LIMITS.delete(key);
    }
  }
}

export function getClientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  return "unknown";
}

export function checkRateLimit(
  ip: string,
  limit = DEFAULT_LIMIT,
  windowMs = DEFAULT_WINDOW_MS,
) {
  const now = Date.now();
  cleanupOldEntries(now);

  const entry = RATE_LIMITS.get(ip);
  if (!entry || entry.resetAt <= now) {
    RATE_LIMITS.set(ip, { count: 1, resetAt: now + windowMs });
    return null;
  }

  if (entry.count >= limit) {
    return Math.ceil((entry.resetAt - now) / 1000);
  }

  entry.count += 1;
  return null;
}
