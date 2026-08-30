import "server-only";

import { getPool } from "@/lib/db";

export type UserProfileRecord = {
  userId: number;
  firstName: string;
  lastName: string;
  companyName: string | null;
};

export async function getUserProfileByUserId(userId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{
    user_id: number;
    first_name: string;
    last_name: string;
    company_name: string | null;
  }>(
    `SELECT user_id, first_name, last_name, company_name
     FROM phis.user_profiles
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    userId: row.user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    companyName: row.company_name,
  } satisfies UserProfileRecord;
}

export async function upsertUserProfile(input: {
  userId: number;
  firstName: string;
  lastName: string;
  companyName?: string | null;
}) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO phis.user_profiles (
       user_id,
       first_name,
       last_name,
       company_name
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
     SET first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         company_name = EXCLUDED.company_name,
         updated_at = NOW()`,
    [input.userId, input.firstName, input.lastName, input.companyName ?? null],
  );
}
