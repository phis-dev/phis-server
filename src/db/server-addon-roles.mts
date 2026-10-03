import type { Pool, PoolClient } from "pg";

import { PhiUserAccountFlag } from "../lib/constants/user-account-flags.ts";
import { USER_SITE_FLAG_DISABLED } from "../lib/user-site-flags.ts";
import { phiPrepared } from "../lib/db-prepared.ts";

/**
 * Which roles of one Add-on a user holds on one Site.
 *
 * The assignments live in Core because the question "what does this person hold here" has to be
 * answerable across every installed Add-on at once. What the names mean is the Add-on's business; Core
 * stores them, answers with them, and never interprets them.
 *
 * The queryable is passed in rather than reached for, because `phis-cli` reads and writes these before
 * an instance is up and the serving process does it during a request.
 */

type Queryable = Pick<Pool | PoolClient, "query">;

export type PhisAddonRoleGrant = {
  addonId: string;
  role: string;
  grantedAt: Date;
  grantedByUserId: number | null;
};

/**
 * The roles one user holds for one Add-on on one Site -- while they can act on that Site at all.
 *
 * A grant outlives a suspension, so lifting it gives the roles back; while the membership on the Site
 * or the account everywhere is disabled, though, the grant is held and not exercised. The same two
 * flags the session reader and `isPhiSiteMember` refuse on.
 */
export async function readPhisAddonUserRoles(
  db: Queryable,
  input: { addonId: string; siteId: number; userId: number },
): Promise<string[]> {
  const { rows } = await db.query<{ role: string }>(
    `SELECT r.role
       FROM phis.site_addon_user_roles r
       JOIN phis.user_site_memberships m ON m.site_id = r.site_id AND m.user_id = r.user_id
       JOIN phis.user_accounts a ON a.id = r.user_id
      WHERE r.site_id = $1 AND r.addon_id = $2 AND r.user_id = $3
        AND (m.user_site_flags & ${USER_SITE_FLAG_DISABLED}) = 0
        AND (a.flags & ${PhiUserAccountFlag.Disabled}) = 0`,
    [input.siteId, input.addonId, input.userId],
  );
  return rows.map((row) => row.role);
}

/** Everything one user holds on one Site, across Add-ons -- the offboarding question. */
export async function readPhiSiteUserAddonRoles(
  db: Queryable,
  input: { siteId: number; userId: number },
): Promise<PhisAddonRoleGrant[]> {
  const { rows } = await db.query<{
    addon_id: string;
    role: string;
    granted_at: Date;
    granted_by_user_id: number | null;
  }>(phiPrepared(
    `SELECT addon_id, role, granted_at, granted_by_user_id
       FROM phis.site_addon_user_roles
      WHERE site_id = $1 AND user_id = $2
      ORDER BY addon_id, role`,
    [input.siteId, input.userId],
  ));
  return rows.map((row) => ({
    addonId: row.addon_id,
    role: row.role,
    grantedAt: row.granted_at,
    grantedByUserId: row.granted_by_user_id,
  }));
}

/**
 * Grants one role, idempotently.
 *
 * Re-granting keeps the first grant rather than restamping it: who first let this person in is the more
 * useful of the two answers, and the second grant added nothing.
 */
export async function grantPhisAddonUserRole(
  db: Queryable,
  input: {
    addonId: string;
    siteId: number;
    userId: number;
    role: string;
    grantedByUserId: number | null;
  },
) {
  // The membership's authorization revision moves in the same statement: a role an Add-on policy reads is
  // part of what a viewer may do, and anything that keeps a viewer's answer by revision must see it change.
  const { rows } = await db.query<{ changed: number }>(
    `WITH granted AS (
       INSERT INTO phis.site_addon_user_roles
         (site_id, addon_id, user_id, role, granted_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (site_id, addon_id, user_id, role) DO NOTHING
       RETURNING user_id
     ), bumped AS (
       UPDATE phis.user_site_memberships
          SET authorization_revision = authorization_revision + 1, updated_at = NOW()
        WHERE site_id = $1 AND user_id IN (SELECT user_id FROM granted)
     )
     SELECT COUNT(*)::int AS changed FROM granted`,
    [input.siteId, input.addonId, input.userId, input.role, input.grantedByUserId],
  );
  return (rows[0]?.changed ?? 0) > 0;
}

export async function revokePhisAddonUserRole(
  db: Queryable,
  input: { addonId: string; siteId: number; userId: number; role: string },
) {
  const { rows } = await db.query<{ changed: number }>(
    `WITH revoked AS (
       DELETE FROM phis.site_addon_user_roles
        WHERE site_id = $1 AND addon_id = $2 AND user_id = $3 AND role = $4
       RETURNING user_id
     ), bumped AS (
       UPDATE phis.user_site_memberships
          SET authorization_revision = authorization_revision + 1, updated_at = NOW()
        WHERE site_id = $1 AND user_id IN (SELECT user_id FROM revoked)
     )
     SELECT COUNT(*)::int AS changed FROM revoked`,
    [input.siteId, input.addonId, input.userId, input.role],
  );
  return (rows[0]?.changed ?? 0) > 0;
}

/**
 * Assignments naming a role the current manifest no longer declares.
 *
 * Reported, never deleted on Core's own initiative. A version that drops a role has not decided that the
 * people holding it should lose their access without anyone noticing; an operator decides that, and
 * needs to be told first.
 */
export async function readPhisAddonOrphanedRoles(
  db: Queryable,
  input: { addonId: string; declared: readonly string[] },
): Promise<{ siteId: number; role: string; holders: number }[]> {
  const { rows } = await db.query<{ site_id: number; role: string; holders: string }>(
    `SELECT site_id, role, COUNT(*)::text AS holders
       FROM phis.site_addon_user_roles
      WHERE addon_id = $1 AND NOT (role = ANY($2::text[]))
      GROUP BY site_id, role
      ORDER BY site_id, role`,
    [input.addonId, [...input.declared]],
  );
  return rows.map((row) => ({
    siteId: row.site_id,
    role: row.role,
    holders: Number(row.holders),
  }));
}
