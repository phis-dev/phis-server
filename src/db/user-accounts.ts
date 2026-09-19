import "server-only";

import type { PoolClient } from "pg";

import {
  PhiUserEmailFlag,
  isPhiUserThemeMode,
  type PhiUserEmailSourceValue,
  type PhiUserThemeModeValue,
} from "@phis/contracts/access";

import { getPool } from "@/lib/db";

export type EnsureUserAccountInput = {
  email: string;
  siteId: number;
  /**
   * Where this address came from. Required rather than defaulted: the answer cannot be reconstructed
   * afterwards, and every caller knows it at the moment it writes.
   */
  emailSource: PhiUserEmailSourceValue;
  medusaCustomerId?: string | null;
  passwordHash?: string | null;
  preferredLocale?: string | null;
  flags?: number;
  reuseExisting?: boolean;
};

export type UserAccountRecord = {
  id: number;
  emailNormalized: string;
  medusaCustomerId: string | null;
  passwordHash: string | null;
  preferredLocale: string | null;
  themeMode: PhiUserThemeModeValue | null;
  siteIds: number[];
  flags: number;
  customerNumber: string | null;
};

type UserAccountRow = {
  id: number;
  email_normalized: string;
  medusa_customer_id: string | null;
  password_hash: string | null;
  preferred_locale: string | null;
  theme_mode: number | null;
  site_ids: number[] | null;
  flags: number;
  customer_number: string | null;
};

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function mapUserAccountRow(row: UserAccountRow): UserAccountRecord {
  return {
    id: row.id,
    emailNormalized: row.email_normalized,
    medusaCustomerId: row.medusa_customer_id,
    passwordHash: row.password_hash,
    preferredLocale: row.preferred_locale,
    // A column value the vocabulary does not name is no answer at all, so it reads as none rather than
    // as a mode nobody offers. The schema check refuses to store one; this is what a hand-edited row gets.
    themeMode: isPhiUserThemeMode(row.theme_mode) ? row.theme_mode : null,
    siteIds: row.site_ids ?? [],
    flags: row.flags,
    customerNumber: row.customer_number,
  };
}

function userAccountProjection(siteParam: number) {
  return `SELECT account.id,
                 email.email_normalized,
                 external.external_account_id AS medusa_customer_id,
                 password.password_hash,
                 account.preferred_locale,
                 account.theme_mode,
                 COALESCE(memberships.site_ids, ARRAY[]::smallint[]) AS site_ids,
                 account.flags,
                 external.customer_number
          FROM phis.user_accounts AS account
          JOIN LATERAL (
            SELECT value.email_normalized
            FROM phis.user_emails AS value
            WHERE value.user_id = account.id
            ORDER BY (value.flags & 1) DESC, value.verified_at ASC, value.id ASC
            LIMIT 1
          ) AS email ON TRUE
          LEFT JOIN phis.user_password_credentials AS password ON password.user_id = account.id
          LEFT JOIN LATERAL (
            SELECT ARRAY_AGG(membership.site_id ORDER BY membership.site_id)::smallint[] AS site_ids
            FROM phis.user_site_memberships AS membership
            WHERE membership.user_id = account.id
          ) AS memberships ON TRUE
          LEFT JOIN LATERAL (
            SELECT mapping.external_account_id, mapping.customer_number
            FROM phis.user_site_external_accounts AS mapping
            WHERE mapping.user_id = account.id
              AND mapping.provider_key = 'medusa'
              AND $${siteParam}::smallint > 0
              AND mapping.site_id = $${siteParam}::smallint
            LIMIT 1
          ) AS external ON TRUE`;
}

async function upsertPasswordCredential(
  client: PoolClient,
  userId: number,
  passwordHash: string | null | undefined,
) {
  if (!passwordHash) {
    return;
  }
  await client.query(
    `INSERT INTO phis.user_password_credentials (user_id, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
     SET password_hash = EXCLUDED.password_hash,
         changed_at = NOW(),
         updated_at = NOW()`,
    [userId, passwordHash],
  );
}

async function upsertMedusaAccount(
  client: PoolClient,
  userId: number,
  siteId: number,
  medusaCustomerId: string | null | undefined,
) {
  if (!medusaCustomerId) {
    return;
  }
  await client.query(
    `INSERT INTO phis.user_site_external_accounts (
       user_id, site_id, provider_key, external_account_id
     )
     VALUES ($1, $2, 'medusa', $3)
     ON CONFLICT (user_id, site_id, provider_key) DO UPDATE
     SET external_account_id = EXCLUDED.external_account_id,
         updated_at = NOW()`,
    [userId, siteId, medusaCustomerId],
  );
}

export async function ensureUserAccount(input: EnsureUserAccountInput) {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) {
    throw new Error("INVALID_EMAIL");
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ user_id: number }>(
      `SELECT user_id
       FROM phis.user_emails
       WHERE email_normalized = $1
       FOR UPDATE`,
      [normalizedEmail],
    );

    let userId = existing.rows[0]?.user_id ?? null;
    if (userId && !input.reuseExisting) {
      throw new Error("ACCOUNT_EXISTS");
    }

    if (!userId) {
      const created = await client.query<{ id: number }>(
        `INSERT INTO phis.user_accounts (preferred_locale, flags)
         VALUES ($1, $2)
         RETURNING id`,
        [input.preferredLocale ?? null, input.flags ?? 0],
      );
      userId = created.rows[0].id;
      await client.query(
        `INSERT INTO phis.user_emails (
           user_id, email_normalized, verified_at, flags, source
         )
         VALUES ($1, $2, NOW(), $3, $4)`,
        [userId, normalizedEmail, PhiUserEmailFlag.Primary, input.emailSource],
      );
    } else {
      await client.query(
        `UPDATE phis.user_accounts
         SET preferred_locale = COALESCE($2, preferred_locale),
             flags = flags | $3,
             updated_at = NOW()
         WHERE id = $1`,
        [userId, input.preferredLocale ?? null, input.flags ?? 0],
      );
    }

    await client.query(
      `INSERT INTO phis.user_site_memberships (user_id, site_id, user_site_flags)
       VALUES ($1, $2, 0)
       ON CONFLICT (user_id, site_id) DO NOTHING`,
      [userId, input.siteId],
    );
    await upsertPasswordCredential(client, userId, input.passwordHash);
    await upsertMedusaAccount(client, userId, input.siteId, input.medusaCustomerId);
    await client.query("COMMIT");
    return { id: userId, emailNormalized: normalizedEmail };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getUserAccountById(userId: number, siteId = 0) {
  const pool = getPool();
  const { rows } = await pool.query<UserAccountRow>(
    `${userAccountProjection(2)}
     WHERE account.id = $1
     LIMIT 1`,
    [userId, siteId],
  );
  return rows[0] ? mapUserAccountRow(rows[0]) : null;
}

export async function getUserAccountByEmail(email: string, siteId = 0) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
  }
  const pool = getPool();
  const { rows } = await pool.query<UserAccountRow>(
    `${userAccountProjection(2)}
     WHERE email.email_normalized = $1
     LIMIT 1`,
    [normalizedEmail, siteId],
  );
  return rows[0] ? mapUserAccountRow(rows[0]) : null;
}

export async function countUserAccountsForSite(siteId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM phis.user_site_memberships
     WHERE site_id = $1`,
    [siteId],
  );
  return Number(rows[0]?.count ?? "0");
}

export async function updateUserAccountPasswordHash(
  userId: number,
  passwordHash: string,
  options?: { clearFlags?: number; setFlags?: number },
) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await upsertPasswordCredential(client, userId, passwordHash);
    await client.query(
      `UPDATE phis.user_accounts
       SET flags = ((flags & ~($2::integer)) | ($3::integer)),
           updated_at = NOW()
       WHERE id = $1`,
      [userId, options?.clearFlags ?? 0, options?.setFlags ?? 0],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateUserAccountFlags(
  userId: number,
  options: { setFlags?: number; clearFlags?: number } = {},
) {
  const pool = getPool();
  const { rows } = await pool.query<{ id: number; flags: number }>(
    `UPDATE phis.user_accounts
     SET flags = ((flags & ~($2::integer)) | ($3::integer)),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, flags`,
    [userId, options.clearFlags ?? 0, options.setFlags ?? 0],
  );
  return rows[0] ?? null;
}

export async function updateUserAccountProfileFields(
  userId: number,
  input: {
    email?: string | null;
    /** Where the new address came from. Required whenever `email` is given, for the reason above. */
    emailSource?: PhiUserEmailSourceValue;
    preferredLocale?: string | null;
    /**
     * Which half of the Theme to store, where `null` is "follow the browser".
     *
     * Absent and `null` mean different things here and cannot share one parameter: `null` is a choice
     * being withdrawn and has to reach the column, while absent must leave a stored choice alone. The
     * statement is told which of the two it is rather than guessing from the value.
     */
    themeMode?: PhiUserThemeModeValue | null;
    setFlags?: number;
    clearFlags?: number;
  } = {},
) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.email) {
      if (!input.emailSource) {
        throw new Error("EMAIL_SOURCE_REQUIRED");
      }
      const normalizedEmail = normalizeEmail(input.email);
      // A new address is a new row, and the old one stays with the origin it was written under. The
      // table was built for this -- the unique index covers only the primary row -- and overwriting in
      // place was throwing away the one fact nobody can reconstruct afterwards: where an address came
      // from. Demote first, so the partial unique index never sees two primaries at once.
      await client.query(
        `UPDATE phis.user_emails
         SET flags = flags & ~$2::int,
             updated_at = NOW()
         WHERE user_id = $1
           AND (flags & $2::int) <> 0`,
        [userId, PhiUserEmailFlag.Primary],
      );
      // Returning to an address this account held before is a promotion of the row that already
      // carries it, keeping its original source. An address belonging to somebody else updates
      // nothing and returns nothing, which is how a stolen login stays impossible even if two
      // requests pass the caller's own check at the same moment.
      const claimed = await client.query<{ id: number }>(
        `INSERT INTO phis.user_emails (
           user_id, email_normalized, verified_at, flags, source
         )
         VALUES ($1, $2, NOW(), $3, $4)
         ON CONFLICT (email_normalized) DO UPDATE
         SET verified_at = NOW(),
             flags = phis.user_emails.flags | EXCLUDED.flags,
             updated_at = NOW()
         WHERE phis.user_emails.user_id = EXCLUDED.user_id
         RETURNING id`,
        [userId, normalizedEmail, PhiUserEmailFlag.Primary, input.emailSource],
      );
      if (!claimed.rowCount) {
        throw new Error("EMAIL_TAKEN");
      }
    }
    const { rows } = await client.query<{
      id: number;
      preferred_locale: string | null;
      theme_mode: number | null;
      flags: number;
    }>(
      `UPDATE phis.user_accounts
       SET preferred_locale = COALESCE($2, preferred_locale),
           theme_mode = CASE WHEN $5::boolean THEN $6::smallint ELSE theme_mode END,
           flags = ((flags & ~($3::integer)) | ($4::integer)),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, preferred_locale, theme_mode, flags`,
      [
        userId,
        input.preferredLocale ?? null,
        input.clearFlags ?? 0,
        input.setFlags ?? 0,
        input.themeMode !== undefined,
        input.themeMode ?? null,
      ],
    );
    const email = await client.query<{ email_normalized: string }>(
      `SELECT email_normalized
       FROM phis.user_emails
       WHERE user_id = $1
       ORDER BY (flags & 1) DESC, verified_at ASC, id ASC
       LIMIT 1`,
      [userId],
    );
    await client.query("COMMIT");
    return rows[0] && email.rows[0]
      ? {
          id: rows[0].id,
          emailNormalized: email.rows[0].email_normalized,
          preferredLocale: rows[0].preferred_locale,
          themeMode: isPhiUserThemeMode(rows[0].theme_mode) ? rows[0].theme_mode : null,
          flags: rows[0].flags,
        }
      : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function removeUserAccountSiteMembership(userId: number, siteId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{ id: number }>(
    `DELETE FROM phis.user_site_memberships
     WHERE user_id = $1 AND site_id = $2
     RETURNING id`,
    [userId, siteId],
  );
  if (!rows[0]) {
    return null;
  }
  const remaining = await pool.query<{ site_id: number }>(
    `SELECT site_id
     FROM phis.user_site_memberships
     WHERE user_id = $1
     ORDER BY site_id`,
    [userId],
  );
  return { id: userId, siteIds: remaining.rows.map((row) => row.site_id) };
}

export async function deleteUserAccount(userId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{ id: number }>(
    `DELETE FROM phis.user_accounts
     WHERE id = $1
     RETURNING id`,
    [userId],
  );
  return rows[0] ?? null;
}
