import type { PoolClient } from "pg";

type DbQueryable = Pick<PoolClient, "query">;

/**
 * The Site's admin letting an Add-on read people with nobody acting (`users:v1` background access,
 * SERVER_ADDONS.md): one row per Site and Add-on, the fields as bits (`PHIS_USER_FIELD_BITS`). The row is
 * the grant and deleting it withdraws it. What counts is the grant's intersection with the manifest's
 * `users.background`, read by the caller: a manifest asking for more keeps the old grant until the admin
 * grants again. Free of `server-only`: the operator grants from the command line.
 */

export type PhisAddonUsersGrant = {
  addonId: string;
  fields: number;
  grantedByUserId: number | null;
  grantedAt: string;
};

/** The fields granted to the Add-on on the Site, as bits; 0 without a grant. */
export async function readPhisAddonUsersGrant(db: DbQueryable, input: { siteId: number; addonId: string }): Promise<number> {
  const { rows } = await db.query<{ fields: number }>(
    `SELECT fields FROM phis.addon_users_grants WHERE site_id = $1 AND addon_id = $2`,
    [input.siteId, input.addonId],
  );
  return rows[0]?.fields ?? 0;
}

/**
 * Grants the fields named (bits, the whole grant: what is not named is no longer granted). True when the
 * grant changed. The caller checks that the Add-on asks for them.
 */
export async function grantPhisAddonUsersBackground(db: DbQueryable, input: {
  siteId: number;
  addonId: string;
  fields: number;
  grantedByUserId: number | null;
}): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO phis.addon_users_grants (site_id, addon_id, fields, granted_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, addon_id) DO UPDATE
     SET fields = EXCLUDED.fields,
         granted_by_user_id = EXCLUDED.granted_by_user_id,
         granted_at = NOW()
     WHERE phis.addon_users_grants.fields <> EXCLUDED.fields`,
    [input.siteId, input.addonId, input.fields, input.grantedByUserId],
  );
  return (rowCount ?? 0) > 0;
}

/** Withdraws the grant; true when there was one. */
export async function revokePhisAddonUsersBackground(db: DbQueryable, input: { siteId: number; addonId: string }): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM phis.addon_users_grants WHERE site_id = $1 AND addon_id = $2`,
    [input.siteId, input.addonId],
  );
  return (rowCount ?? 0) > 0;
}

/** Every grant of the Site, by Add-on. */
export async function listPhisAddonUsersGrants(db: DbQueryable, siteId: number): Promise<PhisAddonUsersGrant[]> {
  const { rows } = await db.query<{ addon_id: string; fields: number; granted_by_user_id: number | null; granted_at: Date }>(
    `SELECT addon_id, fields, granted_by_user_id, granted_at
     FROM phis.addon_users_grants
     WHERE site_id = $1
     ORDER BY addon_id`,
    [siteId],
  );
  return rows.map((row) => ({
    addonId: row.addon_id,
    fields: row.fields,
    grantedByUserId: row.granted_by_user_id,
    grantedAt: row.granted_at.toISOString(),
  }));
}
