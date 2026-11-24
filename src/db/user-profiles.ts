import "server-only";

import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";
import { phiPrepared } from "@/lib/db-prepared";
import { announcePhisUserEvent, schedulePhisUserEventDelivery } from "@/lib/addons/user-events";

export type UserProfileRecord = {
  userId: number;
  firstName: string;
  lastName: string;
  /** The name the person chose to be shown under, or `null` for their first and last name. */
  displayName: string | null;
  companyName: string | null;
  /** Business telephone and mobile number as the person typed them (users:v1 `phone`). */
  phone: string | null;
  mobile: string | null;
};

/**
 * The name a person is shown under where others see them, as a SQL expression over a `user_profiles` row.
 *
 * One rule for every surface that names somebody -- a byline, a conversation, a member list: the name the
 * person chose, otherwise their first and last name, otherwise nothing. An e-mail address is never part of
 * it; a surface that may fall back to one (administration) says so itself, around this expression.
 */
export function userDisplayNameSql(profile: string) {
  return `COALESCE(NULLIF(TRIM(${profile}.display_name), ''), NULLIF(TRIM(CONCAT_WS(' ', ${profile}.first_name, ${profile}.last_name)), ''))`;
}

export async function getUserProfileByUserId(userId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{
    user_id: number;
    first_name: string;
    last_name: string;
    display_name: string | null;
    company_name: string | null;
    phone: string | null;
    mobile: string | null;
  }>(phiPrepared(
    `SELECT user_id, first_name, last_name, display_name, company_name, phone, mobile
     FROM phis.user_profiles
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  ));

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    userId: row.user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    companyName: row.company_name,
    phone: row.phone,
    mobile: row.mobile,
  } satisfies UserProfileRecord;
}

/**
 * Writes a profile's names.
 *
 * `displayName` absent leaves the stored one alone: registration and the e-mail flows write a profile
 * without knowing about it, and a write that cleared it would undo a choice the person made elsewhere.
 * `null` clears it.
 */
export async function upsertUserProfile(input: {
  userId: number;
  firstName: string;
  lastName: string;
  displayName?: string | null;
  companyName?: string | null;
}, db?: Pick<PoolClient, "query">) {
  const pool = db ?? getPool();
  /*
   * A write that changes nothing is not written, so `rowCount` says whether the names changed -- which is
   * what owes `user.changed` with `name` on every Site the person is a member of (users:v1).
   */
  const { rowCount } = await pool.query(
    `INSERT INTO phis.user_profiles (
       user_id,
       first_name,
       last_name,
       display_name,
       company_name
     )
     VALUES ($1, $2, $3, $5, $4)
     ON CONFLICT (user_id) DO UPDATE
     SET first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         display_name = CASE WHEN $6::boolean THEN EXCLUDED.display_name ELSE phis.user_profiles.display_name END,
         company_name = EXCLUDED.company_name,
         updated_at = NOW()
     WHERE (phis.user_profiles.first_name, phis.user_profiles.last_name, phis.user_profiles.company_name)
             IS DISTINCT FROM (EXCLUDED.first_name, EXCLUDED.last_name, EXCLUDED.company_name)
        OR ($6::boolean AND phis.user_profiles.display_name IS DISTINCT FROM EXCLUDED.display_name)`,
    [
      input.userId,
      input.firstName,
      input.lastName,
      input.companyName ?? null,
      input.displayName ?? null,
      input.displayName !== undefined,
    ],
  );
  if ((rowCount ?? 0) > 0) {
    schedulePhisUserEventDelivery(
      await announcePhisUserEvent(pool, { userId: input.userId, siteIds: null, event: "user.changed", fields: ["name"] }),
    );
  }
}

/**
 * Writes a profile's business telephone and mobile number, as the person typed them; the digits-only
 * forms a search matches are derived by the table (`PATCH /api/v1/auth/profile/phone`). A person
 * without a profile has no names yet and is written nothing: false. A change owes `user.changed` with
 * `phone` on every Site the person is a member of.
 */
export async function setUserProfilePhones(input: {
  userId: number;
  phone: string | null;
  mobile: string | null;
}): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query<{ changed: boolean }>(
    `WITH written AS (
       UPDATE phis.user_profiles
       SET phone = $2, mobile = $3, updated_at = NOW()
       WHERE user_id = $1 AND (phone, mobile) IS DISTINCT FROM ($2::varchar, $3::varchar)
       RETURNING user_id
     )
     SELECT EXISTS (SELECT 1 FROM written) AS changed FROM phis.user_profiles WHERE user_id = $1`,
    [input.userId, input.phone, input.mobile],
  );
  if (!rows[0]) {
    return false;
  }
  if (rows[0].changed) {
    schedulePhisUserEventDelivery(
      await announcePhisUserEvent(pool, { userId: input.userId, siteIds: null, event: "user.changed", fields: ["phone"] }),
    );
  }
  return true;
}
