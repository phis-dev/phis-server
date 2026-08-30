import "server-only";

import { getPool } from "@/lib/db";

/**
 * The Asset a person shows as themselves on one Site.
 *
 * Site-scoped rather than global, because the Asset lives in that Site's User Space and an Asset
 * belongs to exactly one Space. A person on two Sites has two avatars, or one and none, and neither
 * Site can see the other's picture.
 *
 * The binding is only ever written for the actor's own membership. Nothing here takes a caller-supplied
 * user id: the routes pass the session's, so there is no shape in which one person sets another's.
 */
export type UserSiteAvatarRecord = {
  userId: number;
  siteId: number;
  assetId: number;
};

export async function getUserSiteAvatar(userId: number, siteId: number) {
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(siteId) || siteId <= 0) {
    return null;
  }
  const { rows } = await getPool().query<{ user_id: number; site_id: number; asset_id: number }>(
    `SELECT user_id, site_id, asset_id
     FROM phis.user_site_avatars
     WHERE user_id = $1 AND site_id = $2
     LIMIT 1`,
    [userId, siteId],
  );
  const row = rows[0];
  return row
    ? ({ userId: row.user_id, siteId: row.site_id, assetId: row.asset_id } satisfies UserSiteAvatarRecord)
    : null;
}

/**
 * Binds one Asset as the actor's avatar, replacing whatever was bound before.
 *
 * The insert names the Asset by id and Site together, so the composite foreign key decides whether the
 * Asset is reachable from this Site at all. A caller that has confirmed Space ownership already still
 * writes through this check rather than around it: the constraint is the authority, and a second
 * opinion in application code is one that can drift.
 */
export async function setUserSiteAvatar(input: { userId: number; siteId: number; assetId: number }) {
  const { rows } = await getPool().query<{ asset_id: number }>(
    `INSERT INTO phis.user_site_avatars (user_id, site_id, asset_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, site_id) DO UPDATE
     SET asset_id = EXCLUDED.asset_id, updated_at = NOW()
     RETURNING asset_id`,
    [input.userId, input.siteId, input.assetId],
  );
  return rows[0] ? { userId: input.userId, siteId: input.siteId, assetId: rows[0].asset_id } : null;
}

export async function clearUserSiteAvatar(userId: number, siteId: number) {
  const result = await getPool().query(
    `DELETE FROM phis.user_site_avatars WHERE user_id = $1 AND site_id = $2`,
    [userId, siteId],
  );
  return (result.rowCount ?? 0) > 0;
}
