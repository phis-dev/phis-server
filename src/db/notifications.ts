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

const OUTBOX_COLUMNS = `id, site_id, provider_id, occasion, flags, recipient_user_id,
   recipient_address, locale, params, attempts`;

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
 * Answers `null` when somebody else holds it or it is already sent, so a best-effort attempt beside the
 * drain cannot send twice.
 */
export async function claimPhiNotificationById(id: string) {
  const { rows } = await getPool().query<OutboxRow>(
    `WITH due AS (
       SELECT id
       FROM phis.notification_outbox
       WHERE id = $1
         AND sent_at IS NULL
         AND attempts < ${MAX_ATTEMPTS}
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

export async function markPhiNotificationSent(id: string, messageId: string | null) {
  await getPool().query(
    `UPDATE phis.notification_outbox
     SET sent_at = NOW(), message_id = $2, last_error = NULL
     WHERE id = $1 AND sent_at IS NULL`,
    [id, messageId],
  );
}

export async function markPhiNotificationFailed(id: string, error: string) {
  await getPool().query(
    `UPDATE phis.notification_outbox
     SET last_error = $2
     WHERE id = $1 AND sent_at IS NULL`,
    [id, error.slice(0, 2000)],
  );
}

/** What is still owed on a Site, for the operator asking whether anything is stuck. */
export async function countOwedPhiNotifications(siteId: number) {
  const { rows } = await getPool().query<{ owed: string; exhausted: string }>(
    `SELECT
       count(*) FILTER (WHERE attempts < ${MAX_ATTEMPTS}) AS owed,
       count(*) FILTER (WHERE attempts >= ${MAX_ATTEMPTS}) AS exhausted
     FROM phis.notification_outbox
     WHERE site_id = $1 AND sent_at IS NULL`,
    [siteId],
  );

  return {
    owed: Number(rows[0]?.owed ?? 0),
    exhausted: Number(rows[0]?.exhausted ?? 0),
  };
}
