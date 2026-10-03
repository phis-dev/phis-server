import "server-only";

import type { PoolClient } from "pg";

import { getPool, withTransaction } from "@/lib/db";
import {
  PHI_CORE_ROLE_PROVIDER_ID,
  type PhiRoleProviderId,
  type PhiViewerRoleClaim,
} from "@/lib/authorization";
import { isUserSiteEnabled } from "@/lib/user-site-flags";
import { resolveEffectivePhiViewerRoleClaims } from "@/lib/effective-authorization";
import { resolveEffectivePhiViewerGroupClaims } from "@/db/site-groups";
import { readAvailablePhisProviderIds } from "@/lib/addons/capability-snapshot";
import { toPhiIsoString } from "@/lib/helpers/timestamp";

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
    lastLoginAt: toPhiIsoString(row.last_login_at),
    enabled: isUserSiteEnabled(row.user_site_flags),
    createdAt: toPhiIsoString(row.created_at),
    updatedAt: toPhiIsoString(row.updated_at),
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
  // The available providers are read once and handed to both projections, which would otherwise each
  // build the same capability snapshot.
  const [membership, availableProviderIds] = await Promise.all([
    getUserSiteMembership(userId, siteId),
    readAvailablePhisProviderIds(siteId),
  ]);
  const roleClaims = resolveEffectivePhiViewerRoleClaims(membership?.roleClaims ?? [], availableProviderIds);
  const groupClaims = await resolveEffectivePhiViewerGroupClaims(siteId, userId, availableProviderIds);
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
  return withTransaction(async (client) => {
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
        // A factor policy scoped to roles may reach these sessions now, and nothing else would make
        // them look: the Site policy revision has not moved. `0` is older than every revision.
        await client.query(
          `UPDATE phis.user_sessions SET auth_policy_revision = 0
           WHERE user_id = $1 AND site_id = $2 AND revoked_at IS NULL AND auth_policy_revision <> 0`,
          [input.userId, input.siteId],
        );
      }
    }
    const roleClaims = await readRoleClaims(client, input.userId, input.siteId);
    return mapMembership(rows[0], roleClaims);
  });
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

/**
 * Sets and clears named flags in one statement, leaving every other bit as the row holds it.
 *
 * It used to take the whole number, computed from a read a moment earlier: a newsletter toggle landing
 * after an administrator disabled the membership wrote the old number back and enabled it again.
 */
export async function changeUserSiteFlags(
  userId: number,
  siteId: number,
  change: { set?: number; clear?: number },
) {
  const pool = getPool();
  const { rows } = await pool.query<UserSiteMembershipRecord>(
    `UPDATE phis.user_site_memberships
     SET user_site_flags = (user_site_flags & ~($4::integer)) | ($3::integer), updated_at = NOW()
     WHERE user_id = $1 AND site_id = $2
     RETURNING id, user_id, site_id, user_site_flags, authorization_revision,
               last_login_at, created_at, updated_at`,
    [userId, siteId, change.set ?? 0, change.clear ?? 0],
  );
  const row = rows[0];
  return row ? mapMembership(row, await readRoleClaims(pool, userId, siteId)) : null;
}

/**
 * What this Site's Modules kept about this person, read on its own.
 *
 * Deliberately not part of `UserSiteMembershipRecord`. `user_sessions` joins this same row on every
 * request that resolves a session and takes one integer out of it; an object carried along there would
 * be paid for by every request, including the ones that render nothing. The renders that want it ask
 * for it.
 *
 * `null` means there is no membership. An empty object means there is one and nothing was ever written.
 */
export async function getPhiUserModuleState(userId: number, siteId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{ module_state: Record<string, unknown> }>(
    `SELECT module_state
     FROM phis.user_site_memberships
     WHERE user_id = $1 AND site_id = $2`,
    [userId, siteId],
  );
  return rows[0]?.module_state ?? null;
}

/** One key's value, for the write that has to know what is already there. */
export async function getPhiUserModuleStateKey(userId: number, siteId: number, key: string) {
  const pool = getPool();
  const { rows } = await pool.query<{ value: unknown }>(
    `SELECT module_state -> $3 AS value
     FROM phis.user_site_memberships
     WHERE user_id = $1 AND site_id = $2`,
    [userId, siteId, key],
  );
  return rows.length > 0 ? rows[0].value ?? null : null;
}

/**
 * One key written, and every other namespace left exactly as it was.
 *
 * `jsonb_set` on the single path is what makes two Modules writing in the same moment harmless: reading
 * the column, changing it and writing it back would let the later write carry the earlier one's stale
 * copy of everything else, and on a row shared by every Module of a Site that is not a rare case.
 *
 * `monotonic` belongs to the `marker` shape, whose promise is that it never moves backwards. The caller
 * has already checked the shape, but a check outside the statement cannot keep that promise: two tabs
 * answering out of order would still unread what somebody read. `GREATEST` decides it where the write
 * happens, so the late answer changes nothing instead of losing the later mark.
 */
export async function setPhiUserModuleStateKey(
  userId: number,
  siteId: number,
  key: string,
  value: unknown,
  options?: { monotonic?: boolean },
) {
  const pool = getPool();
  const assignment = options?.monotonic
    ? `jsonb_set(module_state, ARRAY[$3], to_jsonb(GREATEST(
         COALESCE((module_state #>> ARRAY[$3])::numeric, $4::numeric), $4::numeric)), true)`
    : `jsonb_set(module_state, ARRAY[$3], $4::jsonb, true)`;
  const parameter = options?.monotonic ? value : JSON.stringify(value ?? null);
  const { rows } = await pool.query<{ value: unknown }>(
    `UPDATE phis.user_site_memberships
     SET module_state = ${assignment}, updated_at = NOW()
     WHERE user_id = $1 AND site_id = $2
     RETURNING module_state -> $3 AS value`,
    [userId, siteId, key, parameter],
  );
  return rows.length > 0 ? rows[0].value ?? null : null;
}

/**
 * One key removed, which is not the same as writing a falsy value.
 *
 * An absent key is what a Module reads as "never decided", and a Site that offers somebody a way back --
 * showing a dismissed card again -- needs that state rather than a `false` that means the same thing
 * only by convention.
 */
export async function clearPhiUserModuleStateKey(userId: number, siteId: number, key: string) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE phis.user_site_memberships
     SET module_state = module_state - $3, updated_at = NOW()
     WHERE user_id = $1 AND site_id = $2`,
    [userId, siteId, key],
  );
  return (rowCount ?? 0) > 0;
}
