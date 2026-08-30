import "server-only";

import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";
import {
  PHI_CORE_ROLE_PROVIDER_ID,
  type PhiRoleProviderId,
  type PhiViewerRoleClaim,
} from "@/lib/authorization";
import { isUserSiteEnabled } from "@/lib/user-site-flags";
import { resolveEffectivePhiViewerRoleClaims } from "@/lib/effective-authorization";
import { resolveEffectivePhiViewerGroupClaims } from "@/db/site-groups";

export type UserSiteMembershipRecord = {
  id: number;
  user_id: number;
  site_id: number;
  user_site_flags: number;
  authorization_revision: number;
  last_login_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type UserSiteRoleClaimRecord = {
  provider_id: string;
  role_flags: number;
};

function toIsoString(value: string | Date | null) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

async function readRoleClaims(
  queryable: Pick<PoolClient, "query">,
  userId: number,
  siteId: number,
): Promise<PhiViewerRoleClaim[]> {
  const { rows } = await queryable.query<UserSiteRoleClaimRecord>(
    `SELECT provider_id, role_flags
     FROM phis.user_site_role_claims
     WHERE user_id = $1 AND site_id = $2
     ORDER BY provider_id`,
    [userId, siteId],
  );
  return rows.map((row) => ({
    providerId: row.provider_id as PhiRoleProviderId,
    flags: row.role_flags,
  }));
}

function mapMembership(row: UserSiteMembershipRecord, roleClaims: PhiViewerRoleClaim[]) {
  const coreRoleFlags =
    roleClaims.find((claim) => claim.providerId === PHI_CORE_ROLE_PROVIDER_ID)?.flags ?? 0;
  return {
    id: row.id,
    userId: row.user_id,
    siteId: row.site_id,
    coreRoleFlags,
    roleClaims,
    siteFlags: row.user_site_flags,
    authorizationRevision: row.authorization_revision,
    lastLoginAt: toIsoString(row.last_login_at),
    enabled: isUserSiteEnabled(row.user_site_flags),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export async function getUserSiteMembership(userId: number, siteId: number) {
  const pool = getPool();
  const { rows } = await pool.query<UserSiteMembershipRecord>(
    `SELECT id, user_id, site_id, user_site_flags, authorization_revision,
            last_login_at, created_at, updated_at
     FROM phis.user_site_memberships
     WHERE user_id = $1 AND site_id = $2
     LIMIT 1`,
    [userId, siteId],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return mapMembership(row, await readRoleClaims(pool, userId, siteId));
}

export async function getEffectiveUserSiteAuthorization(userId: number, siteId: number) {
  const membership = await getUserSiteMembership(userId, siteId);
  const [roleClaims, groupClaims] = await Promise.all([
    resolveEffectivePhiViewerRoleClaims(siteId, membership?.roleClaims ?? []),
    resolveEffectivePhiViewerGroupClaims(siteId, userId),
  ]);
  return {
    userId,
    siteId,
    roleClaims,
    groupClaims,
    coreRoleFlags:
      roleClaims.find((claim) => claim.providerId === PHI_CORE_ROLE_PROVIDER_ID)?.flags ?? 0,
    siteFlags: membership?.siteFlags ?? 0,
    authorizationRevision: membership?.authorizationRevision ?? 0,
    enabled: membership?.enabled === true,
  };
}

async function setRoleClaimWithClient(
  client: PoolClient,
  input: {
    userId: number;
    siteId: number;
    providerId: PhiRoleProviderId;
    roleFlags: number;
  },
) {
  if (input.roleFlags > 0) {
    await client.query(
      `INSERT INTO phis.user_site_role_claims (
         user_id, site_id, provider_id, role_flags
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, site_id, provider_id) DO UPDATE
       SET role_flags = EXCLUDED.role_flags,
           updated_at = NOW()
       WHERE phis.user_site_role_claims.role_flags IS DISTINCT FROM EXCLUDED.role_flags`,
      [input.userId, input.siteId, input.providerId, input.roleFlags],
    );
  } else {
    await client.query(
      `DELETE FROM phis.user_site_role_claims
       WHERE user_id = $1 AND site_id = $2 AND provider_id = $3`,
      [input.userId, input.siteId, input.providerId],
    );
  }
}

export async function upsertUserSiteMembership(input: {
  userId: number;
  siteId: number;
  coreRoleFlags?: number;
  userSiteFlags?: number;
}) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<UserSiteMembershipRecord>(
      `INSERT INTO phis.user_site_memberships (
         user_id, site_id, user_site_flags
       )
       VALUES ($1, $2, COALESCE($3::integer, 0))
       ON CONFLICT (user_id, site_id) DO UPDATE
       SET user_site_flags = COALESCE($3::integer, phis.user_site_memberships.user_site_flags),
           updated_at = NOW()
       RETURNING id, user_id, site_id, user_site_flags, authorization_revision,
                 last_login_at, created_at, updated_at`,
      [input.userId, input.siteId, input.userSiteFlags ?? null],
    );
    if (input.coreRoleFlags !== undefined) {
      const before = await readRoleClaims(client, input.userId, input.siteId);
      const previous =
        before.find((claim) => claim.providerId === PHI_CORE_ROLE_PROVIDER_ID)?.flags ?? 0;
      if (previous !== input.coreRoleFlags) {
        await setRoleClaimWithClient(client, {
          userId: input.userId,
          siteId: input.siteId,
          providerId: PHI_CORE_ROLE_PROVIDER_ID,
          roleFlags: input.coreRoleFlags,
        });
        const revision = await client.query<UserSiteMembershipRecord>(
          `UPDATE phis.user_site_memberships
           SET authorization_revision = authorization_revision + 1,
               updated_at = NOW()
           WHERE user_id = $1 AND site_id = $2
           RETURNING id, user_id, site_id, user_site_flags, authorization_revision,
                     last_login_at, created_at, updated_at`,
          [input.userId, input.siteId],
        );
        rows[0] = revision.rows[0];
      }
    }
    const roleClaims = await readRoleClaims(client, input.userId, input.siteId);
    await client.query("COMMIT");
    return mapMembership(rows[0], roleClaims);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordUserSiteLogin(userId: number, siteId: number) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO phis.user_site_memberships (
       user_id, site_id, user_site_flags, last_login_at
     )
     VALUES ($1, $2, 0, NOW())
     ON CONFLICT (user_id, site_id) DO UPDATE
     SET last_login_at = NOW(), updated_at = NOW()`,
    [userId, siteId],
  );
}

export async function setUserSiteFlags(
  userId: number,
  siteId: number,
  userSiteFlags: number,
) {
  const pool = getPool();
  const { rows } = await pool.query<UserSiteMembershipRecord>(
    `UPDATE phis.user_site_memberships
     SET user_site_flags = $3, updated_at = NOW()
     WHERE user_id = $1 AND site_id = $2
     RETURNING id, user_id, site_id, user_site_flags, authorization_revision,
               last_login_at, created_at, updated_at`,
    [userId, siteId, userSiteFlags],
  );
  const row = rows[0];
  return row ? mapMembership(row, await readRoleClaims(pool, userId, siteId)) : null;
}
