import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

import { getPool } from "@/lib/db";
import { sha256Hex } from "@/lib/auth";
import {
  decryptAuthTransactionPayload,
  encryptAuthTransactionPayload,
} from "@/lib/site-auth/transaction-crypto";
import { createTotpSecret, resolveTotpCodeStep, verifyTotpCode } from "@/lib/site-auth/totp";

export const PHI_AUTH_FACTOR_TYPES = {
  passkey: 1,
  totp: 2,
  recoveryCode: 3,
} as const;

type FactorRow = {
  id: string;
  factor_type: number;
  label: string | null;
  secret_ciphertext: string | null;
  secret_iv: string | null;
  secret_auth_tag: string | null;
  confirmed_at: string | Date | null;
  created_at: string | Date;
  last_used_at: string | Date | null;
};

function toIso(value: string | Date | null) {
  return value ? new Date(value).toISOString() : null;
}

function readSecret(row: FactorRow) {
  if (!row.secret_ciphertext || !row.secret_iv || !row.secret_auth_tag) {
    throw new Error("AUTH_FACTOR_SECRET_MISSING");
  }
  const payload = decryptAuthTransactionPayload({
    ciphertextHex: row.secret_ciphertext,
    ivHex: row.secret_iv,
    authTagHex: row.secret_auth_tag,
  });
  if (typeof payload.secretHex !== "string" || !/^[a-f0-9]{40}$/i.test(payload.secretHex)) {
    throw new Error("AUTH_FACTOR_SECRET_INVALID");
  }
  return Buffer.from(payload.secretHex, "hex");
}

export async function listUserAuthFactors(userId: number, siteId: number) {
  const { rows } = await getPool().query<FactorRow>(
    `SELECT id, factor_type, label, secret_ciphertext, secret_iv, secret_auth_tag,
            confirmed_at, created_at, last_used_at
     FROM phis.user_auth_factors
     WHERE user_id = $1 AND site_id = $2
     ORDER BY created_at, id`,
    [userId, siteId],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.factor_type,
    label: row.label,
    confirmedAt: toIso(row.confirmed_at),
    createdAt: toIso(row.created_at),
    lastUsedAt: toIso(row.last_used_at),
  }));
}

export async function hasConfirmedTotpFactor(userId: number, siteId: number) {
  const { rows } = await getPool().query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM phis.user_auth_factors
       WHERE user_id = $1 AND site_id = $2 AND factor_type = $3 AND confirmed_at IS NOT NULL
     ) AS present`,
    [userId, siteId, PHI_AUTH_FACTOR_TYPES.totp],
  );
  return rows[0]?.present === true;
}

export async function createPendingTotpFactor(input: {
  userId: number;
  siteId: number;
  label?: string | null;
}) {
  const pool = getPool();
  await pool.query(
    `DELETE FROM phis.user_auth_factors
     WHERE user_id = $1 AND site_id = $2 AND factor_type = $3 AND confirmed_at IS NULL`,
    [input.userId, input.siteId, PHI_AUTH_FACTOR_TYPES.totp],
  );
  const id = randomUUID();
  const generated = createTotpSecret();
  const encrypted = encryptAuthTransactionPayload({ secretHex: generated.secret.toString("hex") });
  await pool.query(
    `INSERT INTO phis.user_auth_factors (
       id, user_id, site_id, factor_type, secret_ciphertext, secret_iv, secret_auth_tag, label
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.userId,
      input.siteId,
      PHI_AUTH_FACTOR_TYPES.totp,
      encrypted.ciphertextHex,
      encrypted.ivHex,
      encrypted.authTagHex,
      input.label?.trim() || "Authenticator app",
    ],
  );
  return { id, manualKey: generated.manualKey };
}

export async function confirmPendingTotpFactor(input: {
  factorId: string;
  userId: number;
  siteId: number;
  code: unknown;
}) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<FactorRow>(
      `SELECT id, factor_type, label, secret_ciphertext, secret_iv, secret_auth_tag,
              confirmed_at, created_at, last_used_at
       FROM phis.user_auth_factors
       WHERE id = $1 AND user_id = $2 AND site_id = $3 AND factor_type = $4
       FOR UPDATE`,
      [input.factorId, input.userId, input.siteId, PHI_AUTH_FACTOR_TYPES.totp],
    );
    const factor = rows[0];
    if (!factor || factor.confirmed_at || !verifyTotpCode(readSecret(factor), input.code)) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE phis.user_auth_factors SET confirmed_at = NOW(), updated_at = NOW(), last_used_at = NOW()
       WHERE id = $1`,
      [factor.id],
    );
    await client.query(
      `DELETE FROM phis.user_auth_factors
       WHERE user_id = $1 AND site_id = $2 AND factor_type = $3`,
      [input.userId, input.siteId, PHI_AUTH_FACTOR_TYPES.recoveryCode],
    );
    const recoveryCodes = Array.from({ length: 10 }, () => {
      const raw = randomBytes(5).toString("hex").toUpperCase();
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    for (const code of recoveryCodes) {
      await client.query(
        `INSERT INTO phis.user_auth_factors (
           id, user_id, site_id, factor_type, factor_key, label, confirmed_at
         ) VALUES ($1, $2, $3, $4, decode($5, 'hex'), $6, NOW())`,
        [
          randomUUID(),
          input.userId,
          input.siteId,
          PHI_AUTH_FACTOR_TYPES.recoveryCode,
          sha256Hex(code.replace(/[^A-Z0-9]/gi, "").toUpperCase()),
          "Recovery code",
        ],
      );
    }
    await client.query("COMMIT");
    return { factorId: factor.id, recoveryCodes };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyConfirmedTotpFactor(input: {
  userId: number;
  siteId: number;
  code: unknown;
  /** The moment the code is judged at; a test stages a race at a time of its choosing. */
  now?: number;
}) {
  const { rows } = await getPool().query<FactorRow>(
    `SELECT id, factor_type, label, secret_ciphertext, secret_iv, secret_auth_tag,
            confirmed_at, created_at, last_used_at
     FROM phis.user_auth_factors
     WHERE user_id = $1 AND site_id = $2 AND factor_type = $3 AND confirmed_at IS NOT NULL`,
    [input.userId, input.siteId, PHI_AUTH_FACTOR_TYPES.totp],
  );
  for (const row of rows) {
    const step = resolveTotpCodeStep(readSecret(row), input.code, input.now);
    if (step === null) continue;
    /*
     * A code is spent by the step it belongs to, and the spending is the statement: the update lands
     * only where this step is later than the last one accepted, so the same code cannot be taken twice
     * -- not within the ninety seconds the window keeps it valid, and not by two requests racing for it.
     * The step sits in `factor_data`, which the row already carries for what a factor knows about
     * itself; `last_used_at` alone could not say which of three valid steps was the one used.
     */
    const { rowCount } = await getPool().query(
      `UPDATE phis.user_auth_factors
          SET last_used_at = NOW(),
              updated_at = NOW(),
              factor_data = factor_data || jsonb_build_object('lastUsedStep', $2::bigint)
        WHERE id = $1
          AND COALESCE((factor_data->>'lastUsedStep')::bigint, -1) < $2::bigint`,
      [row.id, step],
    );
    return (rowCount ?? 0) > 0;
  }
  return false;
}

export async function consumeRecoveryCode(input: {
  userId: number;
  siteId: number;
  code: unknown;
}) {
  const code = typeof input.code === "string"
    ? input.code.replace(/[^A-Z0-9]/gi, "").toUpperCase()
    : "";
  if (!/^[A-F0-9]{10}$/.test(code)) return false;
  const { rowCount } = await getPool().query(
    `UPDATE phis.user_auth_factors
     SET consumed_at = NOW(), last_used_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND site_id = $2 AND factor_type = $3
       AND factor_key = decode($4, 'hex') AND consumed_at IS NULL`,
    [input.userId, input.siteId, PHI_AUTH_FACTOR_TYPES.recoveryCode, sha256Hex(code)],
  );
  return (rowCount ?? 0) > 0;
}
export async function deleteUserAuthFactor(input: {
  factorId: string;
  userId: number;
  siteId: number;
}) {
  const { rowCount } = await getPool().query(
    `DELETE FROM phis.user_auth_factors
     WHERE id = $1 AND user_id = $2 AND site_id = $3 AND factor_type IN ($4, $5)`,
    [input.factorId, input.userId, input.siteId, PHI_AUTH_FACTOR_TYPES.passkey, PHI_AUTH_FACTOR_TYPES.totp],
  );
  return (rowCount ?? 0) > 0;
}
