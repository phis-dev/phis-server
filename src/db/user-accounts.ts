import "server-only";

import type { PoolClient } from "pg";

import { PhiUserEmailFlag, type PhiUserEmailSourceValue } from "@phis/contracts/access";

import { getPool, withTransaction } from "@/lib/db";
import { normalizePhiEmail } from "@/lib/helpers/normalize";
import { ensurePhiDefaultSiteMembership } from "@/db/user-site-membership-default.mts";
import { phiPrepared } from "@/lib/db-prepared";

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
  siteIds: number[];
  flags: number;
  customerNumber: string | null;
};

export type UserAccountRow = {
  id: number;
  email_normalized: string;
  medusa_customer_id: string | null;
  password_hash: string | null;
  preferred_locale: string | null;
  site_ids: number[] | null;
  flags: number;
  customer_number: string | null;
};

export function mapUserAccountRow(row: UserAccountRow): UserAccountRecord {
  return {
    id: row.id,
    emailNormalized: row.email_normalized,
    medusaCustomerId: row.medusa_customer_id,
    passwordHash: row.password_hash,
    preferredLocale: row.preferred_locale,
    siteIds: row.site_ids ?? [],
    flags: row.flags,
    customerNumber: row.customer_number,
  };
}

export function userAccountProjection(siteParam: number) {
  return `SELECT account.id,
                 email.email_normalized,
                 external.external_account_id AS medusa_customer_id,
                 password.password_hash,
                 account.preferred_locale,
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
  const normalizedEmail = normalizePhiEmail(input.email);
  if (!normalizedEmail) {
    throw new Error("INVALID_EMAIL");
  }

  return withTransaction(async (client) => {
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
      /*
       * The lock above holds a row that exists; an address nobody has yet has no row to lock, so two
       * registrations of it at once both got here. The unique index decides, and the one it refuses
       * reports the address as taken -- the transaction takes the account it just made back with it.
       */
      const claimed = await client.query(
        `INSERT INTO phis.user_emails (
           user_id, email_normalized, verified_at, flags, source
         )
         VALUES ($1, $2, NOW(), $3, $4)
         ON CONFLICT (email_normalized) DO NOTHING`,
        [userId, normalizedEmail, PhiUserEmailFlag.Primary, input.emailSource],
      );
      if ((claimed.rowCount ?? 0) === 0) {
        throw new Error("ACCOUNT_EXISTS");
      }
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

    await ensurePhiDefaultSiteMembership(client, userId, input.siteId);
    await upsertPasswordCredential(client, userId, input.passwordHash);
    await upsertMedusaAccount(client, userId, input.siteId, input.medusaCustomerId);
    return { id: userId, emailNormalized: normalizedEmail };
  });
}

export async function getUserAccountById(userId: number, siteId = 0) {
  const pool = getPool();
  const { rows } = await pool.query<UserAccountRow>(phiPrepared(
    `${userAccountProjection(2)}
     WHERE account.id = $1
     LIMIT 1`,
    [userId, siteId],
  ));
  return rows[0] ? mapUserAccountRow(rows[0]) : null;
}

/**
 * The account an address belongs to, whichever of its addresses it is.
 *
 * Every row of `user_emails` is its account's and nobody else's -- the address is unique across all of
 * them -- so asking only the primary one answered "nobody" for an address that was taken: registering
 * it ended in the unique index as a 500, and its owner could not sign in with it. The account comes
 * back with its primary address, which is where mail goes.
 */
export async function getUserAccountByEmail(email: string, siteId = 0) {
  const normalizedEmail = normalizePhiEmail(email);
  if (!normalizedEmail) {
    return null;
  }
  const pool = getPool();
  const { rows } = await pool.query<UserAccountRow>(
    `${userAccountProjection(2)}
     WHERE account.id = (
       SELECT owner.user_id FROM phis.user_emails AS owner WHERE owner.email_normalized = $1
     )
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

type UserAccountFlagDelta = {
  setFlags?: number;
  clearFlags?: number;
  /** Written where given; an absent or null locale keeps the stored one. */
  preferredLocale?: string | null;
};

/**
 * The one statement that moves an account's flags: the cleared bits first, then the set ones, so a bit
 * named in both ends up set. Three writers carried it, one of them with the locale beside it.
 */
async function applyUserAccountFlagDelta(
  db: Pick<PoolClient, "query">,
  userId: number,
  delta: UserAccountFlagDelta,
) {
  const { rows } = await db.query<{ id: number; preferred_locale: string | null; flags: number }>(
    `UPDATE phis.user_accounts
     SET preferred_locale = COALESCE($4, preferred_locale),
         flags = ((flags & ~($2::integer)) | ($3::integer)),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, preferred_locale, flags`,
    [userId, delta.clearFlags ?? 0, delta.setFlags ?? 0, delta.preferredLocale ?? null],
  );
  return rows[0] ?? null;
}

export async function updateUserAccountPasswordHash(
  userId: number,
  passwordHash: string,
  options?: { clearFlags?: number; setFlags?: number },
) {
  await withTransaction(async (client) => {
    await upsertPasswordCredential(client, userId, passwordHash);
    await applyUserAccountFlagDelta(client, userId, options ?? {});
  });
}

export async function updateUserAccountFlags(
  userId: number,
  options: { setFlags?: number; clearFlags?: number } = {},
) {
  const updated = await applyUserAccountFlagDelta(getPool(), userId, options);
  return updated ? { id: updated.id, flags: updated.flags } : null;
}

export async function updateUserAccountProfileFields(
  userId: number,
  input: {
    email?: string | null;
    /** Where the new address came from. Required whenever `email` is given, for the reason above. */
    emailSource?: PhiUserEmailSourceValue;
    preferredLocale?: string | null;
    setFlags?: number;
    clearFlags?: number;
  } = {},
) {
  return withTransaction(async (client) => {
    if (input.email) {
      if (!input.emailSource) {
        throw new Error("EMAIL_SOURCE_REQUIRED");
      }
      const normalizedEmail = normalizePhiEmail(input.email);
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
    const updated = await applyUserAccountFlagDelta(client, userId, input);
    const email = await client.query<{ email_normalized: string }>(
      `SELECT email_normalized
       FROM phis.user_emails
       WHERE user_id = $1
       ORDER BY (flags & 1) DESC, verified_at ASC, id ASC
       LIMIT 1`,
      [userId],
    );
    return updated && email.rows[0]
      ? {
          id: updated.id,
          emailNormalized: email.rows[0].email_normalized,
          preferredLocale: updated.preferred_locale,
          flags: updated.flags,
        }
      : null;
  });
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
