import "server-only";

import type { PoolClient } from "pg";

import { buildPhisCapabilitySnapshot } from "@/lib/addons/capability-snapshot";
import type { PhiGroupProviderId, PhiViewerGroupClaim } from "@/lib/authorization";
import { getPool } from "@/lib/db";
import {
  PHI_CORE_GROUP_PROVIDER_ID,
  PhiSiteGroupFlags,
  normalizePhiGroupMembershipFlags,
  normalizePhiSiteGroupFlags,
} from "@/lib/constants/site-groups";

type DbQueryable = Pick<PoolClient, "query">;

export type SiteGroupRecord = {
  id: number;
  siteId: number;
  providerId: PhiGroupProviderId;
  key: string;
  name: string;
  flags: number;
  /** When the group was retired, or `null` while it is in service. */
  retiredAt: string | null;
  authority: { providerId: PhiGroupProviderId; connectionKey: string | null };
  capabilities: readonly ("read" | "update" | "delete" | "addMembers" | "removeMembers")[];
};

function normalizeGroupKey(value: string) {
  const key = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,159}$/u.test(key)) throw new Error("Invalid Site group key.");
  return key;
}

type SiteGroupRow = {
  id: number; site_id: number; provider_id: string; key: string; name: string; flags: number;
  retired_at: Date | string | null;
};

function mapGroup(row: SiteGroupRow): SiteGroupRecord {
  const providerId = row.provider_id as PhiGroupProviderId;
  const local = providerId === PHI_CORE_GROUP_PROVIDER_ID;
  return {
    id: row.id,
    siteId: row.site_id,
    providerId,
    key: row.key,
    name: row.name,
    flags: row.flags,
    retiredAt: row.retired_at == null ? null : new Date(row.retired_at).toISOString(),
    authority: { providerId, connectionKey: null },
    capabilities: local ? ["read", "update", "delete", "addMembers", "removeMembers"] : ["read"],
  };
}

/**
 * The Site's groups.
 *
 * Retired groups are left out unless asked for, because every ordinary caller wants the groups that
 * are in service. Administration asks for them: a retired group still holds its key, so the one place
 * that could be surprised by a name being taken is the one place that must be able to see why.
 */
export async function listSiteGroups(siteId: number, options?: { includeRetired?: boolean }) {
  const { rows } = await getPool().query<SiteGroupRow & { member_count: number | string }>(
    `SELECT g.id, g.site_id, g.provider_id, g.key, g.name, g.flags, g.retired_at,
            (SELECT COUNT(*) FROM phis.site_group_members m
              WHERE m.group_id = g.id AND m.site_id = g.site_id) AS member_count
     FROM phis.site_groups g
     WHERE g.site_id = $1 AND ($2 OR g.retired_at IS NULL)
     ORDER BY g.retired_at IS NOT NULL, LOWER(g.name), g.id`,
    [siteId, options?.includeRetired === true],
  );
  return rows.map((row) => ({ ...mapGroup(row), memberCount: Number(row.member_count) }));
}

/**
 * The groups this actor belongs to, with the level they hold in each.
 *
 * Resolved from the same claim projection every authorization decision uses, so a group contributed by
 * a provider appears exactly as it would anywhere else -- including disappearing when that provider is
 * unavailable, which is the behaviour the rest of the system relies on.
 */
export async function listSiteGroupsForUser(siteId: number, userId: number) {
  const claims = await resolveEffectivePhiViewerGroupClaims(siteId, userId);
  if (claims.length === 0) return [];
  const byIdentity = new Map(claims.map((claim) => [`${claim.providerId}\u0000${claim.key}`, claim.flags]));
  const groups = await listSiteGroups(siteId);
  return groups.flatMap((group) => {
    const membershipFlags = byIdentity.get(`${group.providerId}\u0000${group.key}`);
    return membershipFlags == null ? [] : [{ ...group, membershipFlags }];
  });
}

export type SiteGroupMemberRecord = {
  userId: number;
  displayName: string;
  email: string | null;
  companyName: string | null;
  membershipFlags: number;
  sourceProviderId: string;
  sourceConnectionKey: string;
  validUntil: string | null;
  createdAt: string;
};

/**
 * The members of one group, as administration needs to see them.
 *
 * Every source is listed, not just the local one: a member a Directory contributes is a member, and
 * hiding it would make the level someone actually has unexplainable. `sourceProviderId` is what says
 * which rows administration may edit -- a provider-owned row is read here and changed at its source.
 */
/**
 * What one member may see of another.
 *
 * Administration sees the row as it is. A member sees who is in their group and at which level, plus
 * the company when the group says so -- never an address: what a member needs is to recognize a
 * colleague, and a colleague is recognized by name. The projection happens here rather than in the
 * route so no caller can forget it.
 */
export function projectSiteGroupMemberForMember(
  member: SiteGroupMemberRecord,
  groupFlags: number,
): SiteGroupMemberRecord {
  return {
    ...member,
    email: null,
    companyName: (groupFlags & PhiSiteGroupFlags.ShowMemberCompany) !== 0 ? member.companyName : null,
  };
}

export async function listSiteGroupMembers(siteId: number, groupId: number) {
  const { rows } = await getPool().query<{
    user_id: number; display_name: string | null; email_normalized: string | null;
    company_name: string | null;
    membership_flags: number; source_provider_id: string; source_connection_key: string;
    valid_until: Date | string | null; created_at: Date | string;
  }>(
    `SELECT m.user_id,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', up.first_name, up.last_name)), ''), email.email_normalized)
              AS display_name,
            email.email_normalized,
            up.company_name,
            m.membership_flags, m.source_provider_id, m.source_connection_key,
            m.valid_until, m.created_at
     FROM phis.site_group_members m
     LEFT JOIN phis.user_profiles up ON up.user_id = m.user_id
     LEFT JOIN LATERAL (
       SELECT candidate.email_normalized
       FROM phis.user_emails candidate
       WHERE candidate.user_id = m.user_id
       ORDER BY (candidate.flags & 1) DESC, candidate.verified_at DESC, candidate.id ASC
       LIMIT 1
     ) email ON TRUE
     WHERE m.site_id = $1 AND m.group_id = $2
     ORDER BY m.membership_flags DESC,
              LOWER(COALESCE(NULLIF(TRIM(CONCAT_WS(' ', up.first_name, up.last_name)), ''), email.email_normalized, '')),
              m.user_id`,
    [siteId, groupId],
  );
  return rows.map((row): SiteGroupMemberRecord => ({
    userId: row.user_id,
    displayName: row.display_name ?? `#${row.user_id}`,
    email: row.email_normalized,
    companyName: row.company_name,
    membershipFlags: row.membership_flags,
    sourceProviderId: row.source_provider_id,
    sourceConnectionKey: row.source_connection_key,
    validUntil: row.valid_until == null ? null : new Date(row.valid_until).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function createLocalSiteGroup(input: { siteId: number; key: string; name: string }) {
  const key = normalizeGroupKey(input.key);
  const name = input.name.trim();
  if (!name) throw new Error("Site group name is required.");
  const { rows } = await getPool().query<SiteGroupRow>(
    `INSERT INTO phis.site_groups (site_id, provider_id, key, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, site_id, provider_id, key, name, flags, retired_at`,
    [input.siteId, PHI_CORE_GROUP_PROVIDER_ID, key, name],
  );
  return mapGroup(rows[0]!);
}

async function readEffectiveGroupFlagsWithDb(db: DbQueryable, siteId: number, userId: number) {
  const { rows } = await db.query<{
    group_id: number;
    group_provider_id: string;
    group_key: string;
    source_provider_id: string;
    membership_flags: number;
  }>(
    `SELECT g.id AS group_id, g.provider_id AS group_provider_id, g.key AS group_key,
            m.source_provider_id, m.membership_flags
     FROM phis.site_group_members m
     JOIN phis.site_groups g ON g.id = m.group_id AND g.site_id = m.site_id
     WHERE m.site_id = $1 AND m.user_id = $2
       -- A retired group grants nothing. Filtering here rather than at each caller is what makes that
       -- true everywhere at once: every authorization decision reads this one projection.
       AND g.retired_at IS NULL
       AND (m.valid_until IS NULL OR m.valid_until > NOW())`,
    [siteId, userId],
  );
  const snapshot = await buildPhisCapabilitySnapshot(siteId);
  const availableProviders = new Set(
    snapshot.providers.filter((provider) => provider.state === "available").map((provider) => provider.providerId),
  );
  availableProviders.add(PHI_CORE_GROUP_PROVIDER_ID);
  const claims = new Map<string, PhiViewerGroupClaim>();
  for (const row of rows) {
    if (!availableProviders.has(row.source_provider_id) || !availableProviders.has(row.group_provider_id)) continue;
    const id = `${row.group_provider_id}\0${row.group_key}`;
    const current = claims.get(id);
    claims.set(id, {
      providerId: row.group_provider_id as PhiGroupProviderId,
      key: row.group_key,
      flags: (current?.flags ?? 0) | row.membership_flags,
    });
  }
  return [...claims.values()].sort((left, right) =>
    left.providerId.localeCompare(right.providerId) || left.key.localeCompare(right.key),
  );
}

export async function resolveEffectivePhiViewerGroupClaims(siteId: number, userId: number) {
  return readEffectiveGroupFlagsWithDb(getPool(), siteId, userId);
}

export async function getSiteGroupById(siteId: number, groupId: number) {
  const { rows } = await getPool().query<SiteGroupRow>(
    `SELECT id, site_id, provider_id, key, name, flags, retired_at FROM phis.site_groups
     WHERE site_id = $1 AND id = $2`,
    [siteId, groupId],
  );
  return rows[0] ? mapGroup(rows[0]) : null;
}

/**
 * The actor's effective membership level in one group.
 *
 * Resolved through the same claim projection every other authorization decision uses, rather than by
 * reading `site_group_members` directly: the union across sources, the provider-availability filter,
 * and the expiry rule all have to apply here too, and a second query would drift from them.
 */
export async function readEffectiveGroupMembershipFlags(
  siteId: number,
  groupId: number,
  userId: number,
) {
  const group = await getSiteGroupById(siteId, groupId);
  if (!group) return 0;
  const claims = await resolveEffectivePhiViewerGroupClaims(siteId, userId);
  return claims.find((claim) => claim.providerId === group.providerId && claim.key === group.key)?.flags ?? 0;
}

/**
 * Writes a group's display flags.
 *
 * Only bits this build knows survive normalization, so an unknown bit set by a newer build is dropped
 * rather than carried into a decision nothing here understands.
 */
export async function setSiteGroupFlags(siteId: number, groupId: number, flags: number) {
  const { rows } = await getPool().query<SiteGroupRow>(
    `UPDATE phis.site_groups SET flags = $3, updated_at = NOW()
     WHERE site_id = $1 AND id = $2 AND retired_at IS NULL
     RETURNING id, site_id, provider_id, key, name, flags, retired_at`,
    [siteId, groupId, normalizePhiSiteGroupFlags(flags)],
  );
  return rows[0] ? mapGroup(rows[0]) : null;
}

export async function setLocalSiteGroupMembership(input: {
  siteId: number;
  groupId: number;
  userId: number;
  membershipFlags: number;
}) {
  const flags = normalizePhiGroupMembershipFlags(input.membershipFlags);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await readEffectiveGroupFlagsWithDb(client, input.siteId, input.userId);
    const bindingKey = `local:${input.groupId}:${input.userId}`;
    const result = await client.query(
      `INSERT INTO phis.site_group_members (
         group_id, user_id, site_id, source_provider_id, source_connection_key,
         source_binding_or_assertion_key, membership_flags
       )
       -- The provider id is both inserted and compared, so it needs a stated type: without the cast
       -- PostgreSQL deduces text from one use and varchar from the other and rejects the statement.
       SELECT g.id, m.user_id, g.site_id, $4::varchar, 'local', $5, $6
       FROM phis.site_groups g
       JOIN phis.user_site_memberships m ON m.site_id = g.site_id AND m.user_id = $3
       WHERE g.id = $2 AND g.site_id = $1 AND g.provider_id = $4 AND g.retired_at IS NULL
       ON CONFLICT (group_id, user_id, source_provider_id, source_connection_key, source_binding_or_assertion_key)
       DO UPDATE SET membership_flags = EXCLUDED.membership_flags, updated_at = NOW()
       RETURNING group_id`,
      [input.siteId, input.groupId, input.userId, PHI_CORE_GROUP_PROVIDER_ID, bindingKey, flags],
    );
    if (result.rowCount !== 1) {
      throw new Error("Local group not found, retired, or the person is not a member of this Site.");
    }
    const after = await readEffectiveGroupFlagsWithDb(client, input.siteId, input.userId);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await client.query(
        `UPDATE phis.user_site_memberships SET authorization_revision = authorization_revision + 1,
         updated_at = NOW() WHERE site_id = $1 AND user_id = $2`,
        [input.siteId, input.userId],
      );
    }
    await client.query("COMMIT");
    return after;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function removeLocalSiteGroupMembership(input: { siteId: number; groupId: number; userId: number }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await readEffectiveGroupFlagsWithDb(client, input.siteId, input.userId);
    await client.query(
      `DELETE FROM phis.site_group_members m USING phis.site_groups g
       WHERE m.group_id = g.id AND g.site_id = $1 AND g.id = $2 AND m.user_id = $3
         AND m.source_provider_id = $4`,
      [input.siteId, input.groupId, input.userId, PHI_CORE_GROUP_PROVIDER_ID],
    );
    const after = await readEffectiveGroupFlagsWithDb(client, input.siteId, input.userId);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await client.query(
        `UPDATE phis.user_site_memberships SET authorization_revision = authorization_revision + 1,
         updated_at = NOW() WHERE site_id = $1 AND user_id = $2`,
        [input.siteId, input.userId],
      );
    }
    await client.query("COMMIT");
    return after;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Retires a group, or puts it back in service.
 *
 * Retiring is not deleting: the row stays and keeps its `(site_id, provider_id, key)`. Access policies
 * are serialized against that provider-qualified key, so releasing it would let a new group of the same
 * name inherit every policy the old one had, silently. See GROUPS_AND_STORAGE.md, "Retiring a group".
 *
 * Only a locally owned group has a state to write. A group a Directory contributes stops being asserted
 * at its source; retiring it here would state something the source disagrees with at the next sync.
 *
 * Every member's `authorization_revision` moves, in one statement rather than a per-user comparison:
 * the group's claim identity comes from this row alone, so a state change alters the effective claims
 * of every member of it without exception. Membership rows that are already expired are left out --
 * they contribute nothing either way.
 */
export async function setSiteGroupRetirement(input: {
  siteId: number;
  groupId: number;
  retired: boolean;
}) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<SiteGroupRow>(
      `UPDATE phis.site_groups
       SET retired_at = CASE WHEN $3 THEN NOW() ELSE NULL END, updated_at = NOW()
       WHERE site_id = $1 AND id = $2 AND provider_id = $4
         AND (retired_at IS NOT NULL) IS DISTINCT FROM $3
       RETURNING id, site_id, provider_id, key, name, flags, retired_at`,
      [input.siteId, input.groupId, input.retired, PHI_CORE_GROUP_PROVIDER_ID],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE phis.user_site_memberships u
       SET authorization_revision = authorization_revision + 1, updated_at = NOW()
       WHERE u.site_id = $1 AND EXISTS (
         SELECT 1 FROM phis.site_group_members m
         WHERE m.site_id = u.site_id AND m.user_id = u.user_id AND m.group_id = $2
           AND (m.valid_until IS NULL OR m.valid_until > NOW())
       )`,
      [input.siteId, input.groupId],
    );
    await client.query("COMMIT");
    return mapGroup(rows[0]!);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
