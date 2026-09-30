import "server-only";

import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";

type DbQueryable = Pick<PoolClient, "query">;

/**
 * Bit 0 of `notification_outbox.flags`: the message was sent rather than asked for.
 *
 * It decides two things and they belong together -- whether consent had to be there for the row to be
 * written at all, and whether the rendered mail owes an unsubscribe footer. A message somebody's own
 * action asked for carries no footer, because offering to withdraw what cannot be withdrawn is the
 * misrepresentation a consent banner over a session cookie makes.
 */
export const PHI_NOTIFICATION_FLAG_SENT = 1 << 0;

/**
 * Bit 1: the row was settled without being sent, because by the time it was due nobody wanted it.
 *
 * Somebody unsubscribing between the enqueue and the drain is the expected case, not a delivery failure.
 * Counting it as one would have an operator chasing a broken address that never existed, and counting it
 * as a send would record a mail nobody received.
 */
export const PHI_NOTIFICATION_FLAG_DROPPED = 1 << 1;

/** How often one row is tried before it is left alone. A bad address must not be retried forever. */
const MAX_ATTEMPTS = 8;

/** The provider of every occasion Core declares itself, as `server_capabilities` spells it. */
export const PHI_NOTIFICATION_CORE_PROVIDER_ID = "@phis/server/core";

/**
 * Who the message is for.
 *
 * An id wherever one exists, because the address is then resolved when the row is drained: a person who
 * corrected theirs in between is written to correctly, and a membership that is gone is not written to at
 * all. The address form is for the messages that precede an account -- an unconfirmed registration has no
 * membership to point at -- and carries its locale, because there is no profile yet to ask.
 */
export type PhiNotificationRecipient =
  | { userId: number }
  | { address: string; locale: string | null };

export type PhiNotificationRow = {
  id: string;
  siteId: number;
  providerId: string;
  occasion: string;
  flags: number;
  recipientUserId: number | null;
  recipientAddress: string | null;
  locale: string | null;
  params: Record<string, unknown>;
  attempts: number;
};

type OutboxRow = {
  id: string;
  site_id: number;
  provider_id: string;
  occasion: string;
  flags: number;
  recipient_user_id: number | null;
  recipient_address: string | null;
  locale: string | null;
  params: Record<string, unknown> | null;
  attempts: number;
};

/**
 * Qualified, because both claims return them out of an `UPDATE ... FROM due` where the CTE carries an `id`
 * of its own. Unqualified, `id` is ambiguous and Postgres refuses the statement.
 */
const OUTBOX_COLUMNS = `outbox.id, outbox.site_id, outbox.provider_id, outbox.occasion, outbox.flags,
   outbox.recipient_user_id, outbox.recipient_address, outbox.locale, outbox.params, outbox.attempts`;

function toNotificationRow(row: OutboxRow): PhiNotificationRow {
  return {
    id: row.id,
    siteId: row.site_id,
    providerId: row.provider_id,
    occasion: row.occasion,
    flags: row.flags,
    recipientUserId: row.recipient_user_id,
    recipientAddress: row.recipient_address,
    locale: row.locale,
    params: row.params ?? {},
    attempts: row.attempts,
  };
}

/**
 * Writes down one message Core owes, and answers with the row's id.
 *
 * `null` means a row with this `dedupeKey` was already here, which is the answer that makes a repeated
 * run safe: the second run's insert is refused by the partial unique index one row at a time, rather
 * than by a count somebody has to keep. A caller that names no key gets no protection, which is right
 * for a message a person has just triggered.
 *
 * Takes a queryable so the row can be written in the transaction that caused it. Nothing is sent from
 * here -- a message announced before its commit may still roll back.
 */
export async function enqueuePhiNotificationWithDb(
  db: DbQueryable,
  input: {
    siteId: number;
    occasion: string;
    recipient: PhiNotificationRecipient;
    providerId?: string;
    flags?: number;
    params?: Record<string, unknown>;
    dedupeKey?: string | null;
  },
) {
  const recipientUserId = "userId" in input.recipient ? input.recipient.userId : null;
  const recipientAddress = "userId" in input.recipient ? null : input.recipient.address;
  const locale = "userId" in input.recipient ? null : input.recipient.locale;

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO phis.notification_outbox (
       site_id,
       provider_id,
       occasion,
       flags,
       recipient_user_id,
       recipient_address,
       locale,
       params,
       dedupe_key
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (site_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      input.siteId,
      input.providerId ?? PHI_NOTIFICATION_CORE_PROVIDER_ID,
      input.occasion,
      input.flags ?? 0,
      recipientUserId,
      recipientAddress,
      locale,
      JSON.stringify(input.params ?? {}),
      input.dedupeKey ?? null,
    ],
  );

  return rows[0]?.id ?? null;
}

export async function enqueuePhiNotification(input: {
  siteId: number;
  occasion: string;
  recipient: PhiNotificationRecipient;
  providerId?: string;
  flags?: number;
  params?: Record<string, unknown>;
  dedupeKey?: string | null;
}) {
  return enqueuePhiNotificationWithDb(getPool(), input);
}

/**
 * The claim and the next attempt in one statement.
 *
 * Counting the attempt when the row is taken rather than when it fails is what keeps a process that dies
 * mid-send from handing the same row out forever. `SKIP LOCKED` is what lets two drains run without one
 * waiting on the other, and the backoff grows to half an hour and stops there.
 *
 * A row that has been tried `MAX_ATTEMPTS` times is no longer claimed. It stays unsent and says why in
 * `last_error`, which is the visible outcome an address nobody reads should have.
 */
export async function claimDuePhiNotifications(limit: number) {
  const { rows } = await getPool().query<OutboxRow>(
    `WITH due AS (
       SELECT id
       FROM phis.notification_outbox
       WHERE sent_at IS NULL
         AND (flags & ${PHI_NOTIFICATION_FLAG_DROPPED}) = 0
         AND attempts < ${MAX_ATTEMPTS}
         AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE phis.notification_outbox outbox
     SET attempts = outbox.attempts + 1,
         next_attempt_at = NOW() + (LEAST(outbox.attempts + 1, 6) * INTERVAL '5 minutes')
     FROM due
     WHERE outbox.id = due.id
     RETURNING ${OUTBOX_COLUMNS}`,
    [Math.max(1, Math.trunc(limit))],
  );

  return rows.map(toNotificationRow);
}

/**
 * Claims one named row, for the attempt the writing request makes itself.
 *
 * Due-time is part of the predicate here as it is in the drain, and it has to be: each query is its own
 * transaction, so `SKIP LOCKED` stops a concurrent claim but nothing about a finished one. Without the due
 * time, a second call after the first had committed would take the same row again and send it twice.
 */
export async function claimPhiNotificationById(id: string) {
  const { rows } = await getPool().query<OutboxRow>(
    `WITH due AS (
       SELECT id
       FROM phis.notification_outbox
       WHERE id = $1
         AND sent_at IS NULL
         AND (flags & ${PHI_NOTIFICATION_FLAG_DROPPED}) = 0
         AND attempts < ${MAX_ATTEMPTS}
         AND next_attempt_at <= NOW()
       FOR UPDATE SKIP LOCKED
     )
     UPDATE phis.notification_outbox outbox
     SET attempts = outbox.attempts + 1,
         next_attempt_at = NOW() + (LEAST(outbox.attempts + 1, 6) * INTERVAL '5 minutes')
     FROM due
     WHERE outbox.id = due.id
     RETURNING ${OUTBOX_COLUMNS}`,
    [id],
  );

  const row = rows[0];
  return row ? toNotificationRow(row) : null;
}

/**
 * Marks the row sent and empties `params` in the same statement.
 *
 * The parameters are cleared because some of them are secrets. A reset link carries a token whose whole
 * point is that only its `sha256` is kept, and enqueueing the message would otherwise leave the plain
 * value in this table for as long as the row lives -- undoing the hashing it was written with. So it is
 * here while the message is owed, which is minutes, and gone once it is not. `registration_intents` blanks
 * its personal fields on consume for the same reason.
 *
 * What stays is the record: who, when, which occasion, and what the transport called it.
 */
export async function markPhiNotificationSent(id: string, messageId: string | null) {
  await getPool().query(
    `UPDATE phis.notification_outbox
     SET sent_at = NOW(), message_id = $2, last_error = NULL, params = '{}'::jsonb
     WHERE id = $1 AND sent_at IS NULL`,
    [id, messageId],
  );
}

/**
 * Records why an attempt failed, and empties `params` once no further attempt will be made.
 *
 * A row nobody will try again must not keep a secret alive either, and the attempt that reached the
 * ceiling is the last moment anything knows that.
 */
export async function markPhiNotificationFailed(id: string, error: string) {
  await getPool().query(
    `UPDATE phis.notification_outbox
     SET last_error = $2,
         params = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN '{}'::jsonb ELSE params END
     WHERE id = $1 AND sent_at IS NULL`,
    [id, error.slice(0, 2000)],
  );
}

/** What is still owed on a Site, for the operator asking whether anything is stuck. */
export async function countOwedPhiNotifications(siteId: number) {
  const { rows } = await getPool().query<{ owed: string; exhausted: string; dropped: string }>(
    `SELECT
       count(*) FILTER (
         WHERE attempts < ${MAX_ATTEMPTS} AND (flags & ${PHI_NOTIFICATION_FLAG_DROPPED}) = 0
       ) AS owed,
       count(*) FILTER (
         WHERE attempts >= ${MAX_ATTEMPTS} AND (flags & ${PHI_NOTIFICATION_FLAG_DROPPED}) = 0
       ) AS exhausted,
       count(*) FILTER (WHERE (flags & ${PHI_NOTIFICATION_FLAG_DROPPED}) <> 0) AS dropped
     FROM phis.notification_outbox
     WHERE site_id = $1 AND sent_at IS NULL`,
    [siteId],
  );

  return {
    owed: Number(rows[0]?.owed ?? 0),
    exhausted: Number(rows[0]?.exhausted ?? 0),
    dropped: Number(rows[0]?.dropped ?? 0),
  };
}

/**
 * The salt beside one membership, minted on first need and handed back every time after.
 *
 * Unlike a token, a salt may be read again, which is the whole reason the unsubscribe link is built this
 * way: the link has to be renderable for every circular, not only the first. The conflict branch updates
 * nothing -- it exists so the statement answers with the row that is already there instead of needing a
 * second read.
 */
export async function ensurePhiNotificationLinkSalt(userId: number, siteId: number, salt: string) {
  const { rows } = await getPool().query<{ link_salt: string }>(
    `INSERT INTO phis.notification_link_salts (user_id, site_id, link_salt)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, site_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING link_salt`,
    [userId, siteId, salt],
  );

  return rows[0]?.link_salt.trim() ?? null;
}

/**
 * The salt a link has to be checked against, and the note that it was used.
 *
 * `last_used_at` moves on every use rather than on the first, because clearing a flag twice is not an
 * error and a second click deserves the same answer as the first. A membership that is gone answers
 * `null`, which the caller reports rather than dressing up as success.
 */
export async function claimPhiNotificationLinkSalt(userId: number, siteId: number) {
  const { rows } = await getPool().query<{ link_salt: string }>(
    `UPDATE phis.notification_link_salts
     SET last_used_at = NOW()
     WHERE user_id = $1 AND site_id = $2
     RETURNING link_salt`,
    [userId, siteId],
  );

  return rows[0]?.link_salt.trim() ?? null;
}

/**
 * Settles a row that must not go out after all, with the reason in place of a delivery.
 *
 * `params` goes with it: nothing will render this message, so nothing needs its parameters, and some of
 * them are secrets.
 */
export async function markPhiNotificationDropped(id: string, reason: string) {
  await getPool().query(
    `UPDATE phis.notification_outbox
     SET flags = flags | ${PHI_NOTIFICATION_FLAG_DROPPED},
         last_error = $2,
         params = '{}'::jsonb
     WHERE id = $1 AND sent_at IS NULL`,
    [id, reason.slice(0, 2000)],
  );
}
