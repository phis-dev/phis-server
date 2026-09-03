import "server-only";
import { Pool } from "pg";
import { getPhisConfigSync } from "@/lib/config";

function buildPostgresPool(): Pool {
  const connectionString = getPhisConfigSync().database?.uri?.trim() ?? null;

  if (connectionString) {
    return new Pool({ connectionString });
  }

  throw new Error("Missing database.uri in config/phis-runtime.json");
}

let pool: Pool | null = null;

export function getPool() {
  if (!pool) {
    pool = buildPostgresPool();
  }

  return pool;
}
