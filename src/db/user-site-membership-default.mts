import type { PoolClient } from "pg";

/**
 * Makes an account a member of a Site with no flags, leaving an existing membership as it stands.
 *
 * What registering an account and `phis site admin` both do before anything else about the Site, and
 * the one place a new membership's starting flags are stated. Free of `server-only`, because the CLI
 * writes it too; the caller owns the transaction.
 */
export async function ensurePhiDefaultSiteMembership(
  db: Pick<PoolClient, "query">,
  userId: number,
  siteId: number,
) {
  await db.query(
    `INSERT INTO phis.user_site_memberships (user_id, site_id, user_site_flags)
     VALUES ($1, $2, 0)
     ON CONFLICT (user_id, site_id) DO NOTHING`,
    [userId, siteId],
  );
}
