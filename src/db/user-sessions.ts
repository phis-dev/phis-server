import "server-only";

import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { USER_ACCOUNT_FLAG_DISABLED, USER_ACCOUNT_FLAG_MUST_CHANGE_PASSWORD } from "@/lib/user-flags";
import { USER_SITE_FLAG_DISABLED } from "@/lib/user-site-flags";
import {
  PHI_AUTH_SESSION_STATES,
  isPhiAuthSessionState,
  type PhiAuthSessionState,
} from "@/lib/site-auth/contracts";
import {
  buildSessionExpiresAt,
  createSessionId,
  createSessionSecret,
  parseSessionCookieValue,
  SESSION_COOKIE_NAME,
  sha256Hex,
  verifySecretHash,
} from "@/lib/auth";

export type UserSessionRecord = {
  id: string;
  user_id: number;
  site_id: number;
  session_secret_hash: string;
  authenticated_at: string | Date;
  assurance_level: number;
  auth_state: number;
  auth_policy_revision: number;
  auth_method_keys: string[];
  next_path: string;
  expires_at: string | Date;
  last_seen_at: string | Date;
  created_at: string | Date;
  revoked_at: string | Date | null;
  ip_address: string | null;
  user_agent: string | null;
  account_flags?: number;
  user_site_flags?: number;
  core_role_flags?: number;
  current_policy_revision?: number;
};

function toIsoString(value: string | Date | null) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// Only this file writes the column, from the same list; a state it cannot read is a broken row. Reading
// it as `complete` would hand a half-finished login a full session.
function readSessionAuthState(value: unknown) {
  if (!isPhiAuthSessionState(value)) {
    throw new Error(`Unknown session auth_state ${String(value)}.`);
  }
  return value;
}

function mapSessionRow(row: UserSessionRecord) {
  return {
    id: row.id,
    userId: row.user_id,
    siteId: row.site_id,
    sessionSecretHash: row.session_secret_hash,
    authenticatedAt: toIsoString(row.authenticated_at),
    assuranceLevel: row.assurance_level,
    authState: readSessionAuthState(row.auth_state),
    authPolicyRevision: row.auth_policy_revision,
    authMethodKeys: row.auth_method_keys,
    nextPath: row.next_path,
    expiresAt: toIsoString(row.expires_at),
    lastSeenAt: toIsoString(row.last_seen_at),
    createdAt: toIsoString(row.created_at),
    revokedAt: toIsoString(row.revoked_at),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    accountFlags: row.account_flags ?? 0,
    siteFlags: row.user_site_flags ?? 0,
    coreRoleFlags: row.core_role_flags ?? 0,
    currentPolicyRevision: row.current_policy_revision ?? row.auth_policy_revision,
  };
}

export async function createUserSession(input: {
  userId: number;
  siteId: number;
  assuranceLevel?: number;
  authState?: PhiAuthSessionState;
  authPolicyRevision?: number;
  authMethodKeys: string[];
  nextPath?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const sessionId = createSessionId();
  const sessionSecret = createSessionSecret();
  const expiresAt = buildSessionExpiresAt();
  const pool = getPool();

  await pool.query(
    `INSERT INTO phis.user_sessions (
       id,
       user_id,
       site_id,
       session_secret_hash,
       authenticated_at,
       assurance_level,
       auth_state,
       auth_policy_revision,
       auth_method_keys,
       next_path,
       expires_at,
       ip_address,
       user_agent
     )
     VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8::varchar(64)[], $9, $10, $11, $12)`,
    [
      sessionId,
      input.userId,
      input.siteId,
      sha256Hex(sessionSecret),
      input.assuranceLevel ?? 1,
      input.authState ?? PHI_AUTH_SESSION_STATES.complete,
      input.authPolicyRevision ?? 1,
      input.authMethodKeys,
      input.nextPath ?? "/",
      expiresAt.toISOString(),
      input.ipAddress ?? null,
      input.userAgent ?? null,
    ],
  );

  return {
    id: sessionId,
    secret: sessionSecret,
    expiresAt,
  };
}

export async function deleteExpiredUserSessions(retentionDays = 30) {
  const normalizedRetentionDays = Math.max(0, Math.trunc(retentionDays) || 0);
  const pool = getPool();
  await pool.query(
    `DELETE FROM phis.user_sessions
     WHERE expires_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [normalizedRetentionDays],
  );
}

export async function getSessionById(sessionId: string) {
  const pool = getPool();
  const { rows } = await pool.query<UserSessionRecord>(
    `SELECT session.id,
            session.user_id,
            session.site_id,
            session.session_secret_hash,
            session.authenticated_at,
            session.assurance_level,
            session.auth_state,
            session.auth_policy_revision,
            session.auth_method_keys,
            session.next_path,
            session.expires_at,
            session.last_seen_at,
            session.created_at,
            session.revoked_at,
            host(session.ip_address) AS ip_address,
            session.user_agent,
            account.flags AS account_flags,
            membership.user_site_flags,
            COALESCE(core_claim.role_flags, 0) AS core_role_flags,
            auth_config.policy_revision AS current_policy_revision
     FROM phis.user_sessions AS session
     JOIN phis.user_accounts AS account
       ON account.id = session.user_id
     JOIN phis.user_site_memberships AS membership
       ON membership.user_id = session.user_id
      AND membership.site_id = session.site_id
     LEFT JOIN phis.user_site_role_claims AS core_claim
       ON core_claim.user_id = session.user_id
      AND core_claim.site_id = session.site_id
      AND core_claim.provider_id = '@phis/server/core'
     JOIN phis.site_auth_config AS auth_config
       ON auth_config.site_id = session.site_id
     WHERE session.id = $1
     LIMIT 1`,
    [sessionId],
  );

  const row = rows[0];
  return row ? mapSessionRow(row) : null;
}

export async function listUserSessionsForSite(userId: number, siteId: number, limit = 25) {
  const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 25));
  const pool = getPool();
  const { rows } = await pool.query<UserSessionRecord>(
    `SELECT id,
            user_id,
            site_id,
            session_secret_hash,
            authenticated_at,
            assurance_level,
            auth_state,
            auth_policy_revision,
            auth_method_keys,
            next_path,
            expires_at,
            last_seen_at,
            created_at,
            revoked_at,
            host(ip_address) AS ip_address,
            user_agent
     FROM phis.user_sessions
     WHERE user_id = $1
       AND site_id = $2
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [userId, siteId, normalizedLimit],
  );

  return rows.map((row) => ({
    id: row.id,
    createdAt: toIsoString(row.created_at),
    lastSeenAt: toIsoString(row.last_seen_at),
    expiresAt: toIsoString(row.expires_at),
    revokedAt: toIsoString(row.revoked_at),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  }));
}

export async function getSessionFromRequest(
  request: NextRequest,
  expectedSiteId?: number,
  options: {
    allowDisabled?: boolean;
    allowIncomplete?: boolean;
    allowPasswordChangeRequired?: boolean;
  } = {},
) {
  const rawCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
  const parsed = parseSessionCookieValue(rawCookie);
  if (!parsed) {
    return null;
  }

  const session = await getSessionById(parsed.sessionId);
  if (!session || session.revokedAt) {
    return null;
  }

  if (!session.expiresAt || new Date(session.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  if (expectedSiteId && session.siteId !== expectedSiteId) {
    return null;
  }

  if (!verifySecretHash(parsed.sessionSecret, session.sessionSecretHash)) {
    return null;
  }

  if (
    !options.allowDisabled &&
    ((session.accountFlags & USER_ACCOUNT_FLAG_DISABLED) !== 0 ||
      (session.siteFlags & USER_SITE_FLAG_DISABLED) !== 0)
  ) {
    return null;
  }

  /*
   * An account an administrator told to change its password is signed in for that and nothing else:
   * the viewer read that shows the change, the change itself, the sign-in workflow and logout ask for
   * it by name, and every other reader sees no session.
   */
  if (
    !options.allowPasswordChangeRequired &&
    (session.accountFlags & USER_ACCOUNT_FLAG_MUST_CHANGE_PASSWORD) !== 0
  ) {
    return null;
  }

  if (!options.allowIncomplete) {
    if (session.authState !== PHI_AUTH_SESSION_STATES.complete) {
      return null;
    }
    if (session.currentPolicyRevision > session.authPolicyRevision) {
      const nextState = await import("@/lib/site-auth/assurance")
        .then(({ reevaluateCompleteSession }) => reevaluateCompleteSession({
          sessionId: session.id,
          siteId: session.siteId,
          userId: session.userId,
          coreRoleFlags: session.coreRoleFlags,
          authMethodKeys: session.authMethodKeys,
          authPolicyRevision: session.authPolicyRevision,
        }));
      if (nextState !== PHI_AUTH_SESSION_STATES.complete) {
        return null;
      }
    }
  }

  return session;
}

export async function updateUserSessionAuthState(input: {
  sessionId: string;
  authState: PhiAuthSessionState;
  authPolicyRevision: number;
  assuranceLevel?: number;
  authMethodKey?: string;
}) {
  const pool = getPool();
  await pool.query(
    `UPDATE phis.user_sessions
     SET auth_state = $2::smallint,
         auth_policy_revision = $3,
         assurance_level = COALESCE($4, assurance_level),
         auth_method_keys = CASE
           WHEN $5::varchar IS NULL OR $5::varchar = ANY(auth_method_keys) THEN auth_method_keys
           ELSE array_append(auth_method_keys, $5::varchar)
         END,
         authenticated_at = CASE WHEN $2::smallint = 3 THEN NOW() ELSE authenticated_at END,
         last_seen_at = NOW()
     WHERE id = $1`,
    [
      input.sessionId,
      input.authState,
      input.authPolicyRevision,
      input.assuranceLevel ?? null,
      input.authMethodKey ?? null,
    ],
  );
}

export async function revokeSession(sessionId: string) {
  const pool = getPool();
  await pool.query(
    `UPDATE phis.user_sessions
     SET revoked_at = NOW()
     WHERE id = $1`,
    [sessionId],
  );
}

export async function revokeUserSessionForSite(input: {
  sessionId: string;
  userId: number;
  siteId: number;
}) {
  const { rowCount } = await getPool().query(
    `UPDATE phis.user_sessions
     SET revoked_at = NOW()
     WHERE id = $1
       AND user_id = $2
       AND site_id = $3
       AND revoked_at IS NULL`,
    [input.sessionId, input.userId, input.siteId],
  );
  return (rowCount ?? 0) > 0;
}

export async function touchSession(sessionId: string, request?: NextRequest) {
  void request;
  const pool = getPool();
  await pool.query(
    `UPDATE phis.user_sessions
     SET last_seen_at = NOW()
     WHERE id = $1`,
    [sessionId],
  );
}

/**
 * Every open session of this account, optionally sparing the one that asked.
 *
 * A new password is what somebody is told to set when they think another person is signed in as them,
 * and that advice does nothing unless the sessions fall with it: a stolen cookie outlives a password
 * change otherwise, and the intruder never has to know the new one.
 *
 * `exceptSessionId` is who is doing the changing. They proved the old password a moment ago, so there is
 * nothing left to establish and no reason to throw them out of the page they are standing on. Left out
 * where there is nobody to spare -- a password reset arrives through a mail link, with every session on
 * the account belonging to before.
 *
 * Account-wide rather than per Site, because a password is the account's and not one Site's.
 *
 * `$2` is cast to `uuid`, the column's own type. Cast to `text` it compared a uuid with a text and
 * Postgres has no such operator -- `42883`, raised on every call, spared session or not. The callers
 * had already stored the new password by then, so the change went through and the sessions it was
 * meant to end stayed open: the one outcome the paragraph above says must not happen. The id that
 * arrives here has passed `parseSessionCookieValue`, which admits nothing but a uuid.
 */
export async function revokeUserSessions(
  userId: number,
  options: { exceptSessionId?: string } = {},
) {
  const pool = getPool();
  const exceptSessionId = options.exceptSessionId ?? null;
  await pool.query(
    `UPDATE phis.user_sessions
     SET revoked_at = NOW()
     WHERE user_id = $1
       AND revoked_at IS NULL
       AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptSessionId],
  );
}

export async function revokeUserSessionsForSite(userId: number, siteId: number) {
  const pool = getPool();
  await pool.query(
    `UPDATE phis.user_sessions
     SET revoked_at = NOW()
     WHERE user_id = $1
       AND site_id = $2
       AND revoked_at IS NULL`,
    [userId, siteId],
  );
}
