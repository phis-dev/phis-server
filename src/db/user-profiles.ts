import "server-only";

import { getPool } from "@/lib/db";
import { phiPrepared } from "@/lib/db-prepared";

export type UserProfileRecord = {
  userId: number;
  firstName: string;
  lastName: string;
  /** The name the person chose to be shown under, or `null` for their first and last name. */
  displayName: string | null;
  companyName: string | null;
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
  }>(phiPrepared(
    `SELECT user_id, first_name, last_name, display_name, company_name
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
}) {
  const pool = getPool();
  await pool.query(
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
         updated_at = NOW()`,
    [
      input.userId,
      input.firstName,
      input.lastName,
      input.companyName ?? null,
      input.displayName ?? null,
      input.displayName !== undefined,
    ],
  );
}
