import "server-only";

import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import {
  mapPhisAddonCapabilityStateRows,
  phisAddonCapabilityStatesSql,
  type PhisAddonCapabilityStateRow,
} from "@/db/server-addons";
import {
  phiEffectiveGroupMemberRowsSql,
  projectPhiEffectiveGroupClaims,
  type PhiEffectiveGroupMemberRow,
} from "@/db/site-groups";
import { mapUserAccountRow, userAccountProjection, type UserAccountRow } from "@/db/user-accounts";
import {
  acceptSession,
  mapSessionRow,
  PHI_SESSION_ROW_COLUMNS,
  PHI_SESSION_ROW_FROM,
  readSessionCookie,
  type SessionAcceptOptions,
  type UserSessionRecord,
} from "@/db/user-sessions";
import { composeEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import {
  availablePhisProviderIdsOf,
  composePhisCapabilitySnapshot,
  listPhisSnapshotAddonIds,
} from "@/lib/addons/capability-snapshot";
import { getPhisAddonInstalledManifest } from "@/lib/addons/installed";
import type { PhiRoleProviderId } from "@/lib/authorization";
import { phiPrepared } from "@/lib/db-prepared";

type SiteRequestActorRow = UserSessionRecord & {
  authorization_revision: number;
  role_claims: Array<{ provider_id: string; role_flags: number }>;
  group_rows: PhiEffectiveGroupMemberRow[];
  addon_states: PhisAddonCapabilityStateRow[];
  account_row: UserAccountRow | null;
};

/**
 * The signed-in actor of a request -- session, authorization and, where asked for, the account -- from
 * one statement.
 *
 * Every signed-in request asks who is behind it before it does anything else, and the answer used to
 * come from five statements one after the other: the session, the membership again, the role claims,
 * the Add-on states for the capability snapshot, the group claims -- and the account where a handler
 * needed it. All of it hangs off the one session row, so it is read as one row here: the session
 * projection `getSessionFromRequest` reads, with the rest as subqueries beside it. The subqueries are
 * the same SQL the single readers use (`phiEffectiveGroupMemberRowsSql`,
 * `phisAddonCapabilityStatesSql`, `userAccountProjection`), and the same code turns the rows into an
 * answer (`acceptSession`, `composePhisCapabilitySnapshot`, `projectPhiEffectiveGroupClaims`,
 * `composeEffectiveUserSiteAuthorization`), so this read cannot decide differently from them.
 *
 * Reading the authorization before the session's checks have passed costs nothing: a session that fails
 * them is answered null and what was read beside it is dropped. The rare follow-ups stay where they
 * are -- a session whose policy changed is reevaluated inside `acceptSession`, and `touchSession`
 * remains its own write.
 */
export async function getSiteRequestActorFromRequest(
  request: NextRequest,
  siteId: number,
  options: SessionAcceptOptions & {
    /**
     * Also read the account. `externalSiteId` is the Site whose external mapping it carries, as
     * `getUserAccountById(userId, siteId)` takes it; 0 for none.
     */
    account?: { externalSiteId: number };
  } = {},
) {
  const parsed = readSessionCookie(request);
  if (!parsed) {
    return null;
  }

  const manifest = getPhisAddonInstalledManifest();
  const addonIds = listPhisSnapshotAddonIds(manifest);
  const accountSql = options.account
    ? `(SELECT row_to_json(account_row) FROM (
         ${userAccountProjection(3)}
         WHERE account.id = session.user_id
         LIMIT 1
       ) AS account_row)`
    : "NULL";
  const { rows } = await getPool().query<SiteRequestActorRow>(phiPrepared(
    `SELECT ${PHI_SESSION_ROW_COLUMNS},
            membership.authorization_revision,
            COALESCE((
              SELECT json_agg(json_build_object('provider_id', claim.provider_id, 'role_flags', claim.role_flags)
                              ORDER BY claim.provider_id)
              FROM phis.user_site_role_claims AS claim
              WHERE claim.user_id = session.user_id
                AND claim.site_id = session.site_id
            ), '[]'::json) AS role_claims,
            COALESCE((
              SELECT json_agg(group_row)
              FROM (${phiEffectiveGroupMemberRowsSql("session.site_id", "session.user_id")}) AS group_row
            ), '[]'::json) AS group_rows,
            COALESCE((
              SELECT json_agg(addon_row)
              FROM (${phisAddonCapabilityStatesSql("$2::text[]", "session.site_id")}) AS addon_row
            ), '[]'::json) AS addon_states,
            ${accountSql} AS account_row
     FROM ${PHI_SESSION_ROW_FROM}
     WHERE session.id = $1
     LIMIT 1`,
    options.account
      ? [parsed.sessionId, addonIds, options.account.externalSiteId]
      : [parsed.sessionId, addonIds],
  ));
  const row = rows[0];
  if (!row) {
    return null;
  }

  const session = await acceptSession(mapSessionRow(row), parsed, siteId, options);
  if (!session) {
    return null;
  }

  const availableProviderIds = availablePhisProviderIdsOf(
    composePhisCapabilitySnapshot(manifest, mapPhisAddonCapabilityStateRows(row.addon_states)),
  );
  const siteRole = composeEffectiveUserSiteAuthorization({
    userId: session.userId,
    siteId: session.siteId,
    membership: { siteFlags: row.user_site_flags ?? 0, authorizationRevision: row.authorization_revision },
    persistedRoleClaims: row.role_claims.map((claim) => ({
      providerId: claim.provider_id as PhiRoleProviderId,
      flags: claim.role_flags,
    })),
    groupClaims: projectPhiEffectiveGroupClaims(row.group_rows, availableProviderIds),
    availableProviderIds,
  });
  return {
    session,
    siteRole,
    user: row.account_row ? mapUserAccountRow(row.account_row) : null,
  };
}
