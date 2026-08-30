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

  const { rows } = await pool.query<{ expires_at: string }>(
    `INSERT INTO phis.user_password_reset_tokens (
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

export async function consumeUserPasswordResetToken(id: number) {
  const pool = getPool();
  await pool.query(
    `UPDATE phis.user_password_reset_tokens
     SET consumed_at = COALESCE(consumed_at, NOW())
     WHERE id = $1`,
    [id],
  );
}
