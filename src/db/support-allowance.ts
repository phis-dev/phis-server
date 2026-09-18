import "server-only";

import type { PoolClient } from "pg";

import {
  PhisSupportAllowancePeriod,
  type PhisSupportAllowance,
  type PhisSupportAllowanceGrant,
  type PhisSupportAllowancePeriodValue,
} from "@phis/contracts/support";

import { getPool } from "@/lib/db";

/** Pool or client alike: every read here is equally correct inside a caller's transaction and outside. */
type DbQueryable = Pick<PoolClient, "query">;

/**
 * How many requests one person may open for themselves, and who may hand them more.
 *
 * Two numbers that are not the same kind of thing. The **periodic allowance** is the Site's, sits on the
 * ticket type, renews at the calendar boundary and is lost if unused. A **grant** is a stock somebody
 * with the standing to do so handed over -- a shop that sold it, an account manager -- which does not
 * renew and is not lost at the boundary. A ticket spends the periodic allowance first and reaches the
 * stock only when that is empty.
 *
 * Support never decides that somebody has more. Whether a customer paid for ten is knowledge that lives
 * in whatever sold it to them, which is by design a package Support does not know about, so what lives
 * here is the arithmetic and `support:v1` is the hand-over. See design/SUPPORT.md section 5.
 */

export class SupportAllowanceError extends Error {}

/** Refused for the one reason the requester can do something about: they have used what they have. */
export class SupportAllowanceExhaustedError extends SupportAllowanceError {
  constructor(readonly allowance: PhisSupportAllowance) {
    super(`No requests left of type "${allowance.typeKey}".`);
  }
}

/**
 * The start of the period a count is taken over, as SQL rather than as a date computed here.
 *
 * Postgres decides when the month began, because it is also what stamps `created_at`. A boundary
 * computed in the application would be the server's timezone rather than the database's, and the two
 * disagreeing is the kind of thing that shows up once a year as somebody being refused on New Year's Eve.
 */
const PERIOD_START_SQL = `CASE $1::smallint
    WHEN ${PhisSupportAllowancePeriod.Month} THEN date_trunc('month', NOW())
    WHEN ${PhisSupportAllowancePeriod.Year} THEN date_trunc('year', NOW())
    ELSE NULL
  END`;

export type SupportAllowanceTypeRow = {
  id: number;
  key: string;
  requester_allowance: number | null;
  requester_allowance_period: number;
};

async function readAllowanceType(
  queryable: DbQueryable,
  siteId: number,
  type: { id: number } | { key: string },
) {
  const byKey = "key" in type;
  const { rows } = await queryable.query<SupportAllowanceTypeRow>(
    `SELECT id, key, requester_allowance, requester_allowance_period
     FROM phis.support_ticket_types
     WHERE site_id = $1 AND ${byKey ? "key = $2" : "id = $2"}`,
    [siteId, byKey ? type.key : type.id],
  );
  return rows[0] ?? null;
}

/** Live stock: handed over, not spent, not expired, not taken back. */
const LIVE_GRANT_CONDITION = `revoked_at IS NULL
  AND consumed < amount
  AND (expires_at IS NULL OR expires_at > NOW())`;

/**
 * What one person has left of one type, from a type row the caller already read.
 *
 * Exported so a listing that has its rows in hand does not have to re-read them, and -- more to the
 * point -- so it does not restate the arithmetic. A listing that computed "remaining" its own way in one
 * SQL statement would be a second answer to the question the route asks when it refuses, and the two
 * disagreeing is how somebody is told they have one left and then refused.
 */
export async function readSupportAllowance(
  queryable: DbQueryable,
  input: { siteId: number; userId: number; selfServiceChannel: number; type: SupportAllowanceTypeRow },
): Promise<PhisSupportAllowance> {
  const { siteId, userId, type } = input;
  const period = type.requester_allowance_period as PhisSupportAllowancePeriodValue;

  const { rows } = await queryable.query<{
    period_start: string | null;
    used: string;
    granted: string;
  }>(
    `WITH bounds AS (SELECT ${PERIOD_START_SQL} AS period_start)
     SELECT
       bounds.period_start,
       (
         SELECT COUNT(*) FROM phis.support_tickets ticket, bounds
         WHERE ticket.site_id = $2
           AND ticket.requester_user_id = $3
           AND ticket.type_id = $4
           -- Only what they asked for themselves. A Supporter opening a ticket on somebody's behalf is a
           -- decision by somebody entitled to take it, so it neither spends their budget nor can be
           -- refused by it -- and without this line the budget would be spendable by Staff and
           -- unspendable by the person it belongs to.
           AND ticket.channel = $5
           AND (bounds.period_start IS NULL OR ticket.created_at >= bounds.period_start)
       ) AS used,
       (
         SELECT COALESCE(SUM(amount - consumed), 0)
         FROM phis.support_allowance_grants
         WHERE site_id = $2 AND user_id = $3 AND type_id = $4 AND ${LIVE_GRANT_CONDITION}
       ) AS granted
     FROM bounds`,
    [period, siteId, userId, type.id, input.selfServiceChannel],
  );

  const row = rows[0]!;
  const used = Number(row.used);
  const granted = Number(row.granted);
  const limit = type.requester_allowance;

  return {
    typeKey: type.key,
    limit,
    period,
    periodStart: row.period_start,
    used,
    granted,
    /*
     * Absent rather than a large number where there is no limit.
     *
     * "Unlimited" and "very many left" are different answers, and a surface that cannot tell them apart
     * will eventually print one as the other -- "you have 2147483642 requests left" being the friendly
     * version of that mistake.
     */
    remaining: limit == null ? null : Math.max(0, limit - used) + granted,
  };
}

/** What one person may still ask for, of one type. The read behind "you have two left". */
export async function getSupportAllowance(input: {
  siteId: number;
  userId: number;
  typeKey: string;
  selfServiceChannel: number;
}): Promise<PhisSupportAllowance | null> {
  const pool = getPool();
  const type = await readAllowanceType(pool, input.siteId, { key: input.typeKey });
  return type ? readSupportAllowance(pool, { ...input, type }) : null;
}

/**
 * Takes one request out of what this person has, inside the caller's transaction.
 *
 * Returns the grant it came out of, or `null` where the periodic allowance covered it -- which is what
 * the ticket records, so that whoever sold a stock can say which requests it was spent on.
 *
 * **Serialized per person and type.** The count and the spend are two statements, and without a lock two
 * requests arriving together both read four-of-five and both pass. A transaction-scoped advisory lock is
 * the narrowest thing that closes it: it is held only for the rest of this transaction, and it contends
 * only with somebody opening a second ticket of the same type as the same person, which is exactly the
 * case being decided.
 */
export async function consumeSupportAllowanceWithDb(
  client: PoolClient,
  input: { siteId: number; userId: number; typeId: number; selfServiceChannel: number },
): Promise<{ grantId: number | null }> {
  const type = await readAllowanceType(client, input.siteId, { id: input.typeId });
  if (!type) {
    throw new SupportAllowanceError("This Site has no such ticket type.");
  }
  if (type.requester_allowance == null) {
    // No limit on this type, so there is nothing to count, nothing to lock, and no stock to touch.
    return { grantId: null };
  }

  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('phis.support_allowance'), hashtext($1))`,
    [`${input.siteId}:${input.userId}:${input.typeId}`],
  );

  const allowance = await readSupportAllowance(client, { ...input, type });
  if (allowance.used < type.requester_allowance) {
    // The periodic allowance covers it, and a stock that was handed over stays untouched for a period
    // that needs it.
    return { grantId: null };
  }

  const { rows } = await client.query<{ id: number }>(
    `UPDATE phis.support_allowance_grants
     SET consumed = consumed + 1, updated_at = NOW()
     WHERE id = (
       SELECT id FROM phis.support_allowance_grants
       WHERE site_id = $1 AND user_id = $2 AND type_id = $3 AND ${LIVE_GRANT_CONDITION}
       -- Oldest expiry first, so a stock that is about to lapse is the one that gets used. Anything else
       -- spends the grant that would have kept and lets the one with a deadline expire unspent.
       ORDER BY expires_at ASC NULLS LAST, id ASC
       LIMIT 1
       FOR UPDATE
     )
     RETURNING id`,
    [input.siteId, input.userId, input.typeId],
  );

  const grantId = rows[0]?.id;
  if (grantId == null) {
    throw new SupportAllowanceExhaustedError(allowance);
  }
  return { grantId };
}

type GrantRow = {
  id: number;
  type_key: string;
  user_id: number;
  provider_id: string;
  reference: string;
  amount: number;
  consumed: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

function asGrant(row: GrantRow): PhisSupportAllowanceGrant {
  return {
    id: row.id,
    typeKey: row.type_key,
    userId: row.user_id,
    providerId: row.provider_id,
    reference: row.reference,
    amount: row.amount,
    consumed: row.consumed,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

const GRANT_SELECT = `grant_row.id,
  type_row.key AS type_key,
  grant_row.user_id,
  grant_row.provider_id,
  grant_row.reference,
  grant_row.amount,
  grant_row.consumed,
  grant_row.expires_at,
  grant_row.revoked_at,
  grant_row.created_at`;

/**
 * Hands somebody a stock of requests, idempotently on the granter's own reference.
 *
 * Granting the same reference twice is the normal case rather than an error: a payment provider retries
 * its webhook, and the second call has to be answered with the first grant rather than with a second
 * ten. `ON CONFLICT DO NOTHING` plus a read-back is what says that -- `DO UPDATE` would let a retry
 * carrying a different amount quietly rewrite one that has already been partly spent.
 */
export async function grantSupportAllowance(input: {
  siteId: number;
  userId: number;
  typeKey: string;
  providerId: string;
  reference: string;
  amount: number;
  expiresAt?: string | null;
}): Promise<PhisSupportAllowanceGrant> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new SupportAllowanceError("A grant is a whole number of requests, and at least one.");
  }
  const pool = getPool();
  const type = await readAllowanceType(pool, input.siteId, { key: input.typeKey });
  if (!type) {
    throw new SupportAllowanceError(`This Site has no ticket type keyed "${input.typeKey}".`);
  }

  await pool.query(
    `INSERT INTO phis.support_allowance_grants
       (site_id, type_id, user_id, provider_id, reference, amount, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (site_id, provider_id, reference) DO NOTHING`,
    [input.siteId, type.id, input.userId, input.providerId, input.reference, input.amount,
      input.expiresAt ?? null],
  );

  const { rows } = await pool.query<GrantRow>(
    `SELECT ${GRANT_SELECT}
     FROM phis.support_allowance_grants grant_row
     JOIN phis.support_ticket_types type_row ON type_row.id = grant_row.type_id
     WHERE grant_row.site_id = $1 AND grant_row.provider_id = $2 AND grant_row.reference = $3`,
    [input.siteId, input.providerId, input.reference],
  );
  const row = rows[0];
  if (!row) {
    throw new SupportAllowanceError("The grant could not be read back.");
  }
  return asGrant(row);
}

/**
 * Takes back the unspent remainder of a grant, by the reference it was made under.
 *
 * An Add-on revokes what it granted and nothing else, which is why `provider_id` is in the WHERE rather
 * than checked afterwards: the row belonging to somebody else is not found rather than refused.
 *
 * Revoking twice is the same answer as revoking once. The timestamp is kept from the first, because when
 * it was taken back is a fact about the refund and not about the retry.
 */
export async function revokeSupportAllowanceGrant(input: {
  siteId: number;
  providerId: string;
  reference: string;
}): Promise<PhisSupportAllowanceGrant | null> {
  const { rows } = await getPool().query<GrantRow>(
    `UPDATE phis.support_allowance_grants grant_row
     SET revoked_at = COALESCE(grant_row.revoked_at, NOW()), updated_at = NOW()
     FROM phis.support_ticket_types type_row
     WHERE type_row.id = grant_row.type_id
       AND grant_row.site_id = $1
       AND grant_row.provider_id = $2
       AND grant_row.reference = $3
     RETURNING ${GRANT_SELECT}`,
    [input.siteId, input.providerId, input.reference],
  );
  return rows[0] ? asGrant(rows[0]) : null;
}
