import type { Pool, PoolClient } from "pg";

import {
  PHI_CORE_ROLE_PROVIDER_ID,
  PhiBaseRole,
  PhiUserEmailFlag,
  PhiUserEmailSource,
} from "@phis/contracts/access";

/**
 * Site administrators, from the operator's side.
 *
 * A Site with no account has no way in: `/login` renders a form against an empty table, and every path
 * that could hand out the Admin role needs somebody who already holds it. The operator is the one
 * standing outside that circle, so the operator is who opens it -- and since an operator outranks a Site
 * administrator, this grants freely rather than only once. There is no first-admin exception to work
 * around later.
 *
 * These duplicate what `@/db/user-accounts` does for the running server, because that module is
 * `server-only` and the CLI is not a server. The duplication is the boundary, not an oversight.
 */

export type PhiCliSiteAdminGrant = {
  userId: number;
  email: string;
  accountCreated: boolean;
  passwordSet: boolean;
  alreadyAdmin: boolean;
};

export type PhiCliSiteAdminEntry = {
  userId: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  roleFlags: number;
  hasPassword: boolean;
};

async function findUserIdByEmail(db: Pool | PoolClient, email: string) {
  const { rows } = await db.query<{ user_id: number }>(
    `SELECT user_id FROM phis.user_emails WHERE email_normalized = $1 FOR UPDATE`,
    [email],
  );
  return rows[0]?.user_id ?? null;
}

/**
 * Makes somebody an administrator of one Site, creating the account if it is new.
 *
 * The password is only ever written for an account this call brings into being. An address that already
 * exists belongs to a person who may be a member of other Sites, and one command that quietly replaces
 * their credential everywhere is not what an operator asked for -- `setPhiCliUserPassword` is, and it
 * says so.
 */
export async function grantPhiCliSiteAdmin(
  pool: Pool,
  input: {
    siteId: number;
    email: string;
    passwordHash: string;
    preferredLocale?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  },
): Promise<PhiCliSiteAdminGrant> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let userId = await findUserIdByEmail(client, input.email);
    const accountCreated = userId === null;

    if (userId === null) {
      const created = await client.query<{ id: number }>(
        `INSERT INTO phis.user_accounts (preferred_locale, flags)
         VALUES ($1, 0)
         RETURNING id`,
        [input.preferredLocale ?? null],
      );
      userId = created.rows[0]!.id;
      await client.query(
        `INSERT INTO phis.user_emails (
           user_id, email_normalized, verified_at, flags, source
         )
         VALUES ($1, $2, NOW(), $3, $4)`,
        [userId, input.email, PhiUserEmailFlag.Primary, PhiUserEmailSource.Operator],
      );
      await client.query(
        `INSERT INTO phis.user_password_credentials (user_id, password_hash)
         VALUES ($1, $2)`,
        [userId, input.passwordHash],
      );
      if (input.firstName && input.lastName) {
        await client.query(
          `INSERT INTO phis.user_profiles (user_id, first_name, last_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE
           SET first_name = EXCLUDED.first_name,
               last_name = EXCLUDED.last_name,
               updated_at = NOW()`,
          [userId, input.firstName, input.lastName],
        );
      }
    }

    await client.query(
      `INSERT INTO phis.user_site_memberships (user_id, site_id, user_site_flags)
       VALUES ($1, $2, 0)
       ON CONFLICT (user_id, site_id) DO NOTHING`,
      [userId, input.siteId],
    );

    const before = await client.query<{ role_flags: number }>(
      `SELECT role_flags
       FROM phis.user_site_role_claims
       WHERE user_id = $1 AND site_id = $2 AND provider_id = $3`,
      [userId, input.siteId, PHI_CORE_ROLE_PROVIDER_ID],
    );
    const alreadyAdmin =
      ((before.rows[0]?.role_flags ?? 0) & PhiBaseRole.Admin) === PhiBaseRole.Admin;

    // `role_flags | EXCLUDED` rather than an assignment: an operator adding Admin must not silently
    // take away the roles somebody was already given through the UI.
    await client.query(
      `INSERT INTO phis.user_site_role_claims (user_id, site_id, provider_id, role_flags)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, site_id, provider_id) DO UPDATE
       SET role_flags = phis.user_site_role_claims.role_flags | EXCLUDED.role_flags,
           updated_at = NOW()`,
      [userId, input.siteId, PHI_CORE_ROLE_PROVIDER_ID, PhiBaseRole.Admin],
    );

    await client.query("COMMIT");
    return {
      userId,
      email: input.email,
      accountCreated,
      passwordSet: accountCreated,
      alreadyAdmin,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Takes the Admin role away without touching the account.
 *
 * Whether what remains is an update or a deletion is decided before writing, not after: the table holds
 * `CHECK (role_flags > 0)`, so a row emptied down to zero is refused rather than tidied away. That check
 * is right -- a claim row granting nothing is not a statement about anybody -- and it is what makes the
 * last role a deletion instead of an assignment.
 */
export async function revokePhiCliSiteAdmin(
  pool: Pool,
  input: { siteId: number; email: string },
): Promise<{ userId: number; wasAdmin: boolean } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userId = await findUserIdByEmail(client, input.email);
    if (userId === null) {
      await client.query("ROLLBACK");
      return null;
    }
    const { rows } = await client.query<{ role_flags: number }>(
      `SELECT role_flags
       FROM phis.user_site_role_claims
       WHERE user_id = $1 AND site_id = $2 AND provider_id = $3
       FOR UPDATE`,
      [userId, input.siteId, PHI_CORE_ROLE_PROVIDER_ID],
    );
    const current = rows[0]?.role_flags ?? 0;
    if ((current & PhiBaseRole.Admin) === 0) {
      await client.query("COMMIT");
      return { userId, wasAdmin: false };
    }

    const remaining = current & ~PhiBaseRole.Admin;
    if (remaining === 0) {
      await client.query(
        `DELETE FROM phis.user_site_role_claims
         WHERE user_id = $1 AND site_id = $2 AND provider_id = $3`,
        [userId, input.siteId, PHI_CORE_ROLE_PROVIDER_ID],
      );
    } else {
      await client.query(
        `UPDATE phis.user_site_role_claims
         SET role_flags = $4, updated_at = NOW()
         WHERE user_id = $1 AND site_id = $2 AND provider_id = $3`,
        [userId, input.siteId, PHI_CORE_ROLE_PROVIDER_ID, remaining],
      );
    }
    await client.query("COMMIT");
    return { userId, wasAdmin: true };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

/** Who holds the Admin role on one Site. */
export async function listPhiCliSiteAdmins(
  pool: Pool,
  siteId: number,
): Promise<PhiCliSiteAdminEntry[]> {
  const { rows } = await pool.query<{
    user_id: number;
    email_normalized: string;
    first_name: string | null;
    last_name: string | null;
    role_flags: number;
    has_password: boolean;
  }>(
    `SELECT claim.user_id,
            email.email_normalized,
            profile.first_name,
            profile.last_name,
            claim.role_flags,
            (password.user_id IS NOT NULL) AS has_password
     FROM phis.user_site_role_claims claim
     JOIN LATERAL (
       SELECT candidate.email_normalized
       FROM phis.user_emails candidate
       WHERE candidate.user_id = claim.user_id
       ORDER BY (candidate.flags & 1) DESC, candidate.verified_at DESC, candidate.id ASC
       LIMIT 1
     ) AS email ON TRUE
     LEFT JOIN phis.user_profiles profile ON profile.user_id = claim.user_id
     LEFT JOIN phis.user_password_credentials password ON password.user_id = claim.user_id
     WHERE claim.site_id = $1
       AND claim.provider_id = $2
       AND (claim.role_flags & $3::int) <> 0
     ORDER BY email.email_normalized`,
    [siteId, PHI_CORE_ROLE_PROVIDER_ID, PhiBaseRole.Admin],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email_normalized,
    firstName: row.first_name,
    lastName: row.last_name,
    roleFlags: row.role_flags,
    hasPassword: row.has_password,
  }));
}

/**
 * Sets one account's password.
 *
 * `--site` selects the person; it does not narrow the effect. `user_password_credentials` is keyed by
 * account alone, so this credential opens every Site that account belongs to -- which is why the refusal
 * below is worth having, and why the CLI says as much when it writes.
 */
export async function setPhiCliUserPassword(
  pool: Pool,
  input: { siteId: number; email: string; passwordHash: string; overwrite: boolean },
): Promise<
  | { ok: true; userId: number; replaced: boolean; siteIds: number[] }
  | { ok: false; reason: "no-account" | "not-a-member" | "password-exists"; userId?: number }
> {
  const userId = await findUserIdByEmail(pool, input.email);
  if (userId === null) {
    return { ok: false, reason: "no-account" };
  }
  const membership = await pool.query(
    `SELECT 1 FROM phis.user_site_memberships WHERE user_id = $1 AND site_id = $2`,
    [userId, input.siteId],
  );
  if (!membership.rowCount) {
    return { ok: false, reason: "not-a-member", userId };
  }

  const existing = await pool.query(
    `SELECT 1 FROM phis.user_password_credentials WHERE user_id = $1`,
    [userId],
  );
  const replaced = Boolean(existing.rowCount);
  if (replaced && !input.overwrite) {
    return { ok: false, reason: "password-exists", userId };
  }

  await pool.query(
    `INSERT INTO phis.user_password_credentials (user_id, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
     SET password_hash = EXCLUDED.password_hash,
         changed_at = NOW(),
         updated_at = NOW()`,
    [userId, input.passwordHash],
  );

  const sites = await pool.query<{ site_id: number }>(
    `SELECT site_id FROM phis.user_site_memberships WHERE user_id = $1 ORDER BY site_id`,
    [userId],
  );
  return { ok: true, userId, replaced, siteIds: sites.rows.map((row) => row.site_id) };
}
