import "server-only";

import { mapUserAccountRow, type UserAccountRow } from "@/db/user-accounts";
import { userDisplayNameSql } from "@/db/user-profiles";
import { getPool } from "@/lib/db";
import { USER_SITE_FLAG_DISABLED, isUserSiteEnabled } from "@/lib/user-site-flags";
import { PHI_CORE_ROLE_PROVIDER_ID } from "@/lib/authorization";

export type AdminUserAccountType = "customer" | "roles" | "auth";
export type AdminUserSortKey = "name" | "email" | "accountType" | "enabled" | "createdAt" | "lastLoginAt";
export type AdminUserSortOrder = "ascend" | "descend";

export type ListAdminUsersOptions = {
  search?: string;
  accountType?: AdminUserAccountType | "all";
  enabled?: "all" | "enabled" | "disabled";
  sortKey?: AdminUserSortKey | string;
  sortOrder?: AdminUserSortOrder | string;
  page?: number;
  pageSize?: number;
};

/** The account columns are the ones every account read selects, so they are its row type, not a copy. */
type ListAdminUsersQueryResult = UserAccountRow & {
  created_at: string;
  updated_at: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  core_role_flags: number;
  user_site_flags: number;
  last_login_at: string | null;
  display_name: string;
  account_type: AdminUserAccountType;
  enabled: boolean;
  total_count: number;
};

type SiteUserCountQueryResult = {
  site_total: number;
};

function normalizeSearch(value?: string) {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeSortOrder(value?: string): AdminUserSortOrder {
  return value?.trim().toLowerCase() === "descend" ? "descend" : "ascend";
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function buildOrderBy(sortKey: string | undefined, sortOrder: AdminUserSortOrder) {
  const direction = sortOrder === "descend" ? "DESC" : "ASC";
  switch (sortKey) {
    case "email":
      return `base.email_normalized ${direction}, base.id ${direction}`;
    case "accountType":
      return `base.account_type ${direction}, base.id ${direction}`;
    case "enabled":
      return `base.enabled ${direction}, base.id ${direction}`;
    case "createdAt":
      return `base.created_at ${direction}, base.id ${direction}`;
    case "lastLoginAt":
      return `base.last_login_at ${direction} NULLS LAST, base.id ${direction}`;
    case "name":
    default:
      return `base.display_name ${direction}, base.id ${direction}`;
  }
}

export async function listAdminUsersForSite(siteId: number, options: ListAdminUsersOptions = {}) {
  const pool = getPool();
  const params: unknown[] = [siteId];
  const conditions: string[] = [];

  const search = normalizeSearch(options.search);
  if (search) {
    const searchParam = `%${escapeLike(search)}%`;
    params.push(searchParam);
    const index = params.length;
    conditions.push(
      `(
        lower(email.email_normalized) LIKE $${index} ESCAPE '\\'
        OR lower(COALESCE(up.first_name, '')) LIKE $${index} ESCAPE '\\'
        OR lower(COALESCE(up.last_name, '')) LIKE $${index} ESCAPE '\\'
        OR lower(COALESCE(up.company_name, '')) LIKE $${index} ESCAPE '\\'
        OR lower(COALESCE(CONCAT_WS(' ', up.first_name, up.last_name), '')) LIKE $${index} ESCAPE '\\'
        OR lower(COALESCE(up.display_name, '')) LIKE $${index} ESCAPE '\\'
        OR lower(COALESCE(external.customer_number, '')) LIKE $${index} ESCAPE '\\'
      )`,
    );
  }

  const accountType = options.accountType?.trim().toLowerCase();
  if (accountType === "customer") {
    conditions.push(`external.external_account_id IS NOT NULL`);
  } else if (accountType === "roles") {
    conditions.push(`external.external_account_id IS NULL AND (
      COALESCE(core_claim.role_flags, 0) <> 0
    )`);
  } else if (accountType === "auth") {
    conditions.push(`external.external_account_id IS NULL AND COALESCE(core_claim.role_flags, 0) = 0`);
  }

  const enabled = options.enabled?.trim().toLowerCase();
  if (enabled === "enabled") {
    conditions.push(`COALESCE(usr.user_site_flags, 0) & $${params.length + 1} = 0`);
    params.push(USER_SITE_FLAG_DISABLED);
  } else if (enabled === "disabled") {
    conditions.push(`COALESCE(usr.user_site_flags, 0) & $${params.length + 1} <> 0`);
    params.push(USER_SITE_FLAG_DISABLED);
  }

  const pageSize = Math.max(1, Math.min(200, Math.trunc(options.pageSize ?? 20) || 20));
  const page = Math.max(1, Math.trunc(options.page ?? 1) || 1);
  const offset = (page - 1) * pageSize;
  params.push(pageSize, offset);

  const sortOrder = normalizeSortOrder(options.sortOrder);
  const orderBy = buildOrderBy(options.sortKey, sortOrder);

  const sql = `
    WITH base AS (
      SELECT
        ua.id,
        email.email_normalized,
        external.external_account_id AS medusa_customer_id,
        credential.password_hash,
        ua.preferred_locale,
        membership_sites.site_ids,
        ua.flags,
        external.customer_number,
        ua.created_at,
        ua.updated_at,
        up.first_name,
        up.last_name,
        up.company_name,
        COALESCE(core_claim.role_flags, 0) AS core_role_flags,
        usr.user_site_flags,
        usr.last_login_at,
        COALESCE(${userDisplayNameSql("up")}, email.email_normalized) AS display_name,
        CASE
          WHEN external.external_account_id IS NOT NULL THEN 'customer'
          WHEN COALESCE(core_claim.role_flags, 0) <> 0 THEN 'roles'
          ELSE 'auth'
        END AS account_type,
        usr.user_site_flags & ${USER_SITE_FLAG_DISABLED} = 0 AS enabled
      FROM phis.user_site_memberships usr
      JOIN phis.user_accounts ua
        ON ua.id = usr.user_id
      JOIN LATERAL (
        SELECT candidate.email_normalized
        FROM phis.user_emails candidate
        WHERE candidate.user_id = ua.id
        ORDER BY (candidate.flags & 1) DESC, candidate.verified_at DESC, candidate.id ASC
        LIMIT 1
      ) email ON TRUE
      LEFT JOIN phis.user_password_credentials credential
        ON credential.user_id = ua.id
      LEFT JOIN phis.user_site_external_accounts external
        ON external.user_id = ua.id
       AND external.site_id = usr.site_id
       AND external.provider_key = 'medusa'
      JOIN LATERAL (
        SELECT ARRAY_AGG(membership.site_id ORDER BY membership.site_id)::int[] AS site_ids
        FROM phis.user_site_memberships membership
        WHERE membership.user_id = ua.id
      ) membership_sites ON TRUE
      LEFT JOIN phis.user_profiles up
        ON up.user_id = ua.id
      LEFT JOIN phis.user_site_role_claims core_claim
        ON core_claim.user_id = ua.id
       AND core_claim.site_id = $1
       AND core_claim.provider_id = '${PHI_CORE_ROLE_PROVIDER_ID}'
      WHERE usr.site_id = $1${conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : ""}
    )
    SELECT
      base.*,
      COUNT(*) OVER()::int AS total_count
    FROM base
    ORDER BY ${orderBy}
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
  `;

  const [{ rows }, siteTotalResult] = await Promise.all([
    pool.query<ListAdminUsersQueryResult>(sql, params),
    pool.query<SiteUserCountQueryResult>(
      `SELECT COUNT(*)::int AS site_total
       FROM phis.user_site_memberships
       WHERE site_id = $1`,
      [siteId],
    ),
  ]);
  const total = rows[0]?.total_count ?? 0;
  const siteTotal = siteTotalResult.rows[0]?.site_total ?? 0;

  return {
    rows: rows.map((row) => ({
      ...mapUserAccountRow(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      firstName: row.first_name,
      lastName: row.last_name,
      companyName: row.company_name,
      coreRoleFlags: row.core_role_flags,
      siteFlags: row.user_site_flags,
      lastLoginAt: row.last_login_at,
      displayName: row.display_name,
      accountType: row.account_type,
      enabled: row.enabled,
    })),
    total,
    siteTotal,
    page,
    pageSize,
  };
}

export async function setAdminUserEnabled(userId: number, siteId: number, enabled: boolean) {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: number;
    user_site_flags: number;
  }>(
    `UPDATE phis.user_site_memberships
     SET user_site_flags = CASE
           WHEN $3::boolean THEN (user_site_flags & ~($4::integer))
           ELSE (user_site_flags | $4::integer)
         END,
         updated_at = NOW()
     WHERE user_id = $1
       AND site_id = $2
     RETURNING id, user_site_flags`,
    [userId, siteId, enabled, USER_SITE_FLAG_DISABLED],
  );

  return rows[0]
    ? {
        id: rows[0].id,
        siteFlags: rows[0].user_site_flags,
        enabled: isUserSiteEnabled(rows[0].user_site_flags),
      }
    : null;
}

/**
 * People a group's Manager may name as a member.
 *
 * Deliberately narrow: Site members only, matched on name or address, capped, and answering with the
 * name and company rather than the address. A Manager needs to find a colleague, not to enumerate the
 * Site -- and the address they may have searched by is not handed back to them.
 */
/**
 * People who may be named as a member, for one group.
 *
 * The group is part of the question rather than a filter applied afterwards: whether someone is already
 * in it decides what naming them will do -- adding them, or changing the level they already hold. The
 * answer says so, so the interface can, instead of presenting both outcomes as the same choice.
 * Membership is read the same way the effective claims are, so an expired row does not count.
 */
export async function searchSiteGroupMemberCandidates(input: {
  siteId: number;
  query: string;
  limit?: number;
  groupId?: number | null;
}) {
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const pattern = `%${query.replace(/[%_\\]/gu, (match) => `\\${match}`)}%`;
  const { rows } = await getPool().query<{
    id: number; display_name: string | null; company_name: string | null; member: boolean;
  }>(
    `SELECT ua.id,
            COALESCE(${userDisplayNameSql("up")}, email.email_normalized)
              AS display_name,
            up.company_name,
            EXISTS (
              SELECT 1 FROM phis.site_group_members m
              WHERE m.site_id = usm.site_id AND m.user_id = ua.id AND m.group_id = $5
                AND (m.valid_until IS NULL OR m.valid_until > NOW())
            ) AS member
     FROM phis.user_site_memberships usm
     JOIN phis.user_accounts ua ON ua.id = usm.user_id
     LEFT JOIN phis.user_profiles up ON up.user_id = ua.id
     LEFT JOIN LATERAL (
       SELECT candidate.email_normalized
       FROM phis.user_emails candidate
       WHERE candidate.user_id = ua.id
       ORDER BY (candidate.flags & 1) DESC, candidate.verified_at DESC, candidate.id ASC
       LIMIT 1
     ) email ON TRUE
     WHERE usm.site_id = $1
       AND ($2 = ''
         OR email.email_normalized ILIKE $3 ESCAPE '\\'
         OR COALESCE(${userDisplayNameSql("up")}, '') ILIKE $3 ESCAPE '\\')
     ORDER BY LOWER(COALESCE(${userDisplayNameSql("up")}, email.email_normalized, '')),
              ua.id
     LIMIT $4`,
    [input.siteId, query, pattern, limit, input.groupId ?? 0],
  );
  return rows.map((row) => ({
    userId: row.id,
    displayName: row.display_name ?? `#${row.id}`,
    companyName: row.company_name,
    member: row.member,
  }));
}
