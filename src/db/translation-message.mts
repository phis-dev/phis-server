import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

/*
 * The one way a message enters a translation store, for the request path and for `phis translations
 * import --add`. It sits in a module free of `server-only` and the `@/` alias because the CLI cannot
 * import the rest of the database layer; `ensureSiteMessageId` and the global fill in `translations.ts`
 * wrap it with the Server's pool.
 *
 * The key is the SHA-256 of the message's first 50 characters plus the context, as stored in
 * `msg_hash`/`ctx`. Nothing here may change that: every stored key and every CDN answer is addressed by it.
 */

type TranslationQueryClient = Pick<Pool | PoolClient, "query">;

/** The fixed prefix a message hash covers; see `TR_HASH_PREFIX_LENGTH` in `lib/translations.ts` for why it stays. */
const TR_HASH_PREFIX_LENGTH = 50;

export function computePhiMessageHash(msg: string) {
  return createHash("sha256").update(msg.slice(0, TR_HASH_PREFIX_LENGTH)).digest("hex");
}

export function normalizePhiMessageHash(msgHash: string) {
  if (!/^[0-9a-f]{64}$/i.test(msgHash)) {
    throw new Error("Invalid translation message hash.");
  }

  return msgHash.toLowerCase();
}

function formatCollisionDetails(details: Record<string, unknown>) {
  return JSON.stringify(details);
}

export function createPhiGlobalCollisionError(msg: string, ctx: string, msgHash: string, existingMsg: string) {
  return new Error(
    `Hash collision detected for tr_msg: ${formatCollisionDetails({ hash: msgHash, ctx, msg, existingMsg })}`,
  );
}

export function createPhiSiteCollisionError(
  siteId: number,
  msg: string,
  ctx: string,
  msgHash: string,
  existingMsg: string,
) {
  return new Error(
    `Hash collision detected for tr_site_msg: ${formatCollisionDetails({ siteId, hash: msgHash, ctx, msg, existingMsg })}`,
  );
}

/** The id of a global message, created where missing. */
export async function ensurePhiGlobalMessageId(
  database: TranslationQueryClient,
  msg: string,
  ctx: string,
  msgHash: string,
) {
  const normalizedHash = normalizePhiMessageHash(msgHash);

  await database.query(
    `INSERT INTO phis.tr_msg (msg, msg_hash, ctx)
     VALUES ($1, decode($2, 'hex'), $3)
     ON CONFLICT (msg_hash, ctx) DO NOTHING`,
    [msg, normalizedHash, ctx],
  );

  const { rows } = await database.query<{ id: number; msg: string }>(
    "SELECT id, msg FROM phis.tr_msg WHERE msg_hash = decode($1, 'hex') AND ctx = $2 LIMIT 1",
    [normalizedHash, ctx],
  );

  if (!rows[0]) {
    throw new Error("Failed to persist translation message.");
  }

  if (rows[0].msg !== msg) {
    throw createPhiGlobalCollisionError(msg, ctx, normalizedHash, rows[0].msg);
  }

  return rows[0].id;
}

/** The id of a Site's message, created where missing. */
export async function ensurePhiSiteMessageId(
  database: TranslationQueryClient,
  siteId: number,
  msg: string,
  ctx: string,
) {
  const normalizedHash = computePhiMessageHash(msg);

  await database.query(
    `INSERT INTO phis.tr_site_msg (site_id, msg, msg_hash, ctx)
     VALUES ($1, $2, decode($3, 'hex'), $4)
     ON CONFLICT (site_id, msg_hash, ctx) DO NOTHING`,
    [siteId, msg, normalizedHash, ctx],
  );

  const { rows: insertedRows } = await database.query<{ id: number; msg: string }>(
    `SELECT id, msg
     FROM phis.tr_site_msg
     WHERE site_id = $1
       AND msg_hash = decode($2, 'hex')
       AND ctx = $3
     LIMIT 1`,
    [siteId, normalizedHash, ctx],
  );

  if (!insertedRows[0] || insertedRows[0].msg !== msg) {
    throw createPhiSiteCollisionError(siteId, msg, ctx, normalizedHash, insertedRows[0]?.msg ?? "");
  }

  return insertedRows[0].id;
}
