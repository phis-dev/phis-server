import "server-only";
import { Pool, type PoolClient } from "pg";
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

/**
 * Runs `body` inside one transaction on one pooled client: BEGIN, COMMIT on success, ROLLBACK on any
 * throw, release always.
 *
 * About fifty hand-written copies of this frame existed, and inside one of them a statement sent to the
 * pool instead of the client ran on another connection and escaped the transaction. With the frame in
 * one place, the body only ever sees the client it has to use.
 */
export async function withTransaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
