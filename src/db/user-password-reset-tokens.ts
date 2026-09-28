import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { getPool } from "@/lib/db";

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function createUserPasswordResetToken(input: {
  userId: number;
  siteId: number;
  ttlSeconds?: number;
}) {
  const ttlSeconds = Math.max(60, Math.trunc(input.ttlSeconds ?? 2 * 60 * 60));
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(token);
  const pool = getPool();

  // The newest link is the only one that works. Earlier ones stayed valid for their two hours, so a
  // mail sitting in an old inbox kept a way into the account open after a newer one was asked for.
  const { rows } = await pool.query<{ expires_at: string }>(
    `WITH retired AS (
       UPDATE phis.user_password_reset_tokens
       SET consumed_at = NOW()
       WHERE user_id = $1 AND site_id = $2 AND consumed_at IS NULL
     )
     INSERT INTO phis.user_password_reset_tokens (
       user_id,
       site_id,
       token_hash,
       expires_at
     )
     VALUES ($1, $2, $3, NOW() + ($4::text || ' seconds')::interval)
     RETURNING expires_at`,
    [input.userId, input.siteId, tokenHash, ttlSeconds],
  );

  return {
    token,
    expiresAt: rows[0]?.expires_at ?? null,
  };
}

export async function getUserPasswordResetTokenByRawToken(siteId: number, rawToken: string) {
  const tokenHash = sha256Hex(rawToken);
  const pool = getPool();
  const { rows } = await pool.query<{
    id: number;
    user_id: number;
    site_id: number;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT id, user_id, site_id, expires_at, consumed_at
     FROM phis.user_password_reset_tokens
     WHERE site_id = $1
       AND token_hash = $2
     LIMIT 1`,
    [siteId, tokenHash],
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    siteId: row.site_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

/**
 * Takes a token for the one password it may set: unconsumed and unexpired, in the statement that marks it
 * used. Reading it and marking it afterwards let two requests carrying the same link both set a password.
 */
export async function claimUserPasswordResetToken(id: number) {
  const { rowCount } = await getPool().query(
    `UPDATE phis.user_password_reset_tokens
     SET consumed_at = NOW()
     WHERE id = $1 AND consumed_at IS NULL AND expires_at > NOW()`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}
