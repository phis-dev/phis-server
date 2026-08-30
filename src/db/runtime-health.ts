import "server-only";

import { Client } from "pg";

const DB_HEALTH_CACHE_TTL_MS = 5000;

type CachedHealthCheck = {
  checkedAt: number;
  value: boolean;
};

const healthCache = new Map<string, CachedHealthCheck>();

export async function isDatabaseAvailable(connectionString: string | undefined) {
  const normalizedConnectionString = connectionString?.trim() ?? "";
  if (!normalizedConnectionString) {
    return false;
  }

  const cached = healthCache.get(normalizedConnectionString);
  if (cached && Date.now() - cached.checkedAt < DB_HEALTH_CACHE_TTL_MS) {
    return cached.value;
  }

  const client = new Client({
    connectionString: normalizedConnectionString,
    connectionTimeoutMillis: 400,
    query_timeout: 400,
  });

  try {
    await client.connect();
    await client.query("SELECT 1");
    healthCache.set(normalizedConnectionString, {
      checkedAt: Date.now(),
      value: true,
    });
    return true;
  } catch {
    healthCache.set(normalizedConnectionString, {
      checkedAt: Date.now(),
      value: false,
    });
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
