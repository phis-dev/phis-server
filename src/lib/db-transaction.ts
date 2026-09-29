import type { Pool, PoolClient } from "pg";

/**
 * Runs `body` inside one transaction on one client of `pool`: BEGIN, COMMIT on success, ROLLBACK on any
 * throw, release always.
 *
 * The pool is a parameter so the CLI, which opens its own, uses the same frame as the Server; this file
 * therefore imports nothing `server-only`. `withTransaction` in `lib/db.ts` is this over the Server pool.
 *
 * Returning from `body` commits. A path that has to undo what it wrote throws; one that wrote nothing
 * may simply return, and the commit of an empty transaction changes nothing.
 */
export async function withPoolTransaction<T>(
  pool: Pick<Pool, "connect">,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
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
