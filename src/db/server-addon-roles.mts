import type { Pool, PoolClient } from "pg";

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

export type PhiServerAddonRoleGrant = {
  addonId: string;
  role: string;
  grantedAt: Date;
  grantedByUserId: number | null;
};

export async function readPhiServerAddonUserRoles(
  db: Queryable,
  input: { addonId: string; siteId: number; userId: number },
): Promise<string[]> {
  const { rows } = await db.query<{ role: string }>(
    `SELECT role
       FROM phis.site_addon_user_roles
      WHERE site_id = $1 AND addon_id = $2 AND user_id = $3`,
    [input.siteId, input.addonId, input.userId],
  );
  return rows.map((row) => row.role);
}

/** Everything one user holds on one Site, across Add-ons -- the offboarding question. */
export async function readPhiSiteUserAddonRoles(
  db: Queryable,
  input: { siteId: number; userId: number },
): Promise<PhiServerAddonRoleGrant[]> {
  const { rows } = await db.query<{
    addon_id: string;
    role: string;
    granted_at: Date;
    granted_by_user_id: number | null;
  }>(
    `SELECT addon_id, role, granted_at, granted_by_user_id
       FROM phis.site_addon_user_roles
      WHERE site_id = $1 AND user_id = $2
      ORDER BY addon_id, role`,
    [input.siteId, input.userId],
  );
  return rows.map((row) => ({
    addonId: row.addon_id,
    role: row.role,
    grantedAt: row.granted_at,
    grantedByUserId: row.granted_by_user_id,
  }));
}

/** Who holds one role of one Add-on here. */
export async function readPhiServerAddonRoleHolders(
  db: Queryable,
  input: { addonId: string; siteId: number; role: string },
): Promise<number[]> {
  const { rows } = await db.query<{ user_id: number }>(
    `SELECT user_id
       FROM phis.site_addon_user_roles
      WHERE site_id = $1 AND addon_id = $2 AND role = $3
      ORDER BY user_id`,
    [input.siteId, input.addonId, input.role],
  );
  return rows.map((row) => row.user_id);
}

/**
 * Grants one role, idempotently.
 *
 * Re-granting keeps the first grant rather than restamping it: who first let this person in is the more
 * useful of the two answers, and the second grant added nothing.
 */
export async function grantPhiServerAddonUserRole(
  db: Queryable,
  input: {
    addonId: string;
    siteId: number;
    userId: number;
    role: string;
    grantedByUserId: number | null;
  },
) {
  const { rowCount } = await db.query(
    `INSERT INTO phis.site_addon_user_roles
       (site_id, addon_id, user_id, role, granted_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id, addon_id, user_id, role) DO NOTHING`,
    [input.siteId, input.addonId, input.userId, input.role, input.grantedByUserId],
  );
  return (rowCount ?? 0) > 0;
}

export async function revokePhiServerAddonUserRole(
  db: Queryable,
  input: { addonId: string; siteId: number; userId: number; role: string },
) {
  const { rowCount } = await db.query(
    `DELETE FROM phis.site_addon_user_roles
      WHERE site_id = $1 AND addon_id = $2 AND user_id = $3 AND role = $4`,
    [input.siteId, input.addonId, input.userId, input.role],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Assignments naming a role the current manifest no longer declares.
 *
 * Reported, never deleted on Core's own initiative. A version that drops a role has not decided that the
 * people holding it should lose their access without anyone noticing; an operator decides that, and
 * needs to be told first.
 */
export async function readPhiServerAddonOrphanedRoles(
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
