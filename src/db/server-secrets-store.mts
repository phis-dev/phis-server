import type { PoolClient } from "pg";

import {
  decryptPhiSecret,
  encryptPhiSecret,
  type PhiSecretCipherRecord,
  type PhiSecretEncryptionKey,
} from "../lib/secrets/crypto.ts";
import { isPhiSecretReference, parsePhiSecretReference } from "../lib/secrets/reference.ts";

type DbQueryable = Pick<PoolClient, "query">;

export type PhisSecretRecord = {
  reference: string;
  siteId: number | null;
  addonId: string | null;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
};

type SecretRow = {
  reference: string;
  site_id: number | null;
  addon_id: string | null;
  key_version: number;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toRecord(row: SecretRow): PhisSecretRecord {
  return {
    reference: row.reference,
    siteId: row.site_id,
    addonId: row.addon_id,
    keyVersion: row.key_version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toCipher(row: SecretRow): PhiSecretCipherRecord {
  return {
    // CHAR(24)/CHAR(32) come back space-padded when a value is ever written short; the check
    // constraints make that impossible, but reading is not the place to rely on it.
    ciphertext: row.ciphertext.trim(),
    iv: row.iv.trim(),
    authTag: row.auth_tag.trim(),
    keyVersion: row.key_version,
  };
}

/**
 * Writes one secret, replacing whatever was there.
 *
 * The owner columns are derived from the reference rather than passed alongside it, so the row cannot
 * disagree with the name it is stored under -- and deleting a Site or an Add-on takes its secrets with
 * it through the foreign keys rather than through a sweep somebody has to remember to run.
 */
export async function writePhisSecretWithDb(
  db: DbQueryable,
  input: {
    reference: string;
    value: string;
    key: PhiSecretEncryptionKey;
    siteId?: number | null;
  },
): Promise<PhisSecretRecord> {
  const identity = parsePhiSecretReference(input.reference);
  if (!identity) {
    throw new Error(`"${input.reference}" is not a valid secret reference.`);
  }
  if (identity.siteKey != null && input.siteId == null) {
    throw new Error(`Secret ${input.reference} names a Site but no Site id was resolved for it.`);
  }
  if (identity.siteKey == null && input.siteId != null) {
    throw new Error(`Secret ${input.reference} names no Site but a Site id was given.`);
  }
  if (!input.value) {
    throw new Error("Refusing to store an empty secret.");
  }

  const cipher = encryptPhiSecret(input.value, input.key);
  const { rows } = await db.query<SecretRow>(
    `INSERT INTO phis.server_secrets (
       reference, site_id, addon_id, key_version, ciphertext, iv, auth_tag
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (reference) DO UPDATE
     SET site_id = EXCLUDED.site_id,
         addon_id = EXCLUDED.addon_id,
         key_version = EXCLUDED.key_version,
         ciphertext = EXCLUDED.ciphertext,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         updated_at = NOW()
     RETURNING reference, site_id, addon_id, key_version, ciphertext, iv, auth_tag, created_at, updated_at`,
    [
      input.reference,
      input.siteId ?? null,
      identity.owner.kind === "addon" ? identity.owner.addonId : null,
      cipher.keyVersion,
      cipher.ciphertext,
      cipher.iv,
      cipher.authTag,
    ],
  );
  return toRecord(rows[0]!);
}

/**
 * Reads one secret, or null when there is none.
 *
 * A row that cannot be decrypted throws rather than answering null: a missing secret and an unreadable
 * one call for different operator action, and collapsing them would let a rotated-away key look like a
 * configuration that was never done.
 */
export async function readPhisSecretWithDb(
  db: DbQueryable,
  reference: string,
  key: PhiSecretEncryptionKey,
): Promise<string | null> {
  if (!isPhiSecretReference(reference)) return null;
  const { rows } = await db.query<SecretRow>(
    `SELECT reference, site_id, addon_id, key_version, ciphertext, iv, auth_tag, created_at, updated_at
     FROM phis.server_secrets
     WHERE reference = $1
     LIMIT 1`,
    [reference],
  );
  const row = rows[0];
  if (!row) return null;
  return decryptPhiSecret(toCipher(row), key);
}

/** Whether a secret exists, without decrypting it -- what a status surface is allowed to know. */
export async function hasPhisSecretWithDb(db: DbQueryable, reference: string) {
  if (!isPhiSecretReference(reference)) return false;
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT TRUE AS exists FROM phis.server_secrets WHERE reference = $1 LIMIT 1`,
    [reference],
  );
  return rows.length > 0;
}

/**
 * Which of these secrets exist, in one query and without decrypting any.
 *
 * The public Auth manifest asks whether a provider is configured, not what its secret is; asking one
 * question per provider on a hot public endpoint would decrypt for an answer that never needed a
 * plaintext.
 */
export async function hasPhisSecretsWithDb(db: DbQueryable, references: string[]) {
  const candidates = references.filter((reference) => isPhiSecretReference(reference));
  if (candidates.length === 0) {
    return new Set<string>();
  }
  const { rows } = await db.query<{ reference: string }>(
    `SELECT reference FROM phis.server_secrets WHERE reference = ANY($1::text[])`,
    [candidates],
  );
  return new Set(rows.map((row) => row.reference));
}

export async function deletePhisSecretWithDb(db: DbQueryable, reference: string) {
  const { rowCount } = await db.query(
    `DELETE FROM phis.server_secrets WHERE reference = $1`,
    [reference],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Lists what exists without ever returning a value.
 *
 * This is the inventory an operator needs to see what is configured, and it is deliberately incapable
 * of leaking: no ciphertext leaves, so no caller can be tempted to decrypt outside the resolver.
 */
export async function listPhisSecretsWithDb(db: DbQueryable, filter?: {
  siteId?: number | null;
  addonId?: string | null;
}): Promise<PhisSecretRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter?.siteId !== undefined) {
    if (filter.siteId === null) {
      conditions.push("site_id IS NULL");
    } else {
      params.push(filter.siteId);
      conditions.push(`site_id = $${params.length}`);
    }
  }
  if (filter?.addonId !== undefined) {
    if (filter.addonId === null) {
      conditions.push("addon_id IS NULL");
    } else {
      params.push(filter.addonId);
      conditions.push(`addon_id = $${params.length}`);
    }
  }
  const { rows } = await db.query<SecretRow>(
    `SELECT reference, site_id, addon_id, key_version, ciphertext, iv, auth_tag, created_at, updated_at
     FROM phis.server_secrets
     ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY reference ASC`,
    params,
  );
  return rows.map(toRecord);
}
