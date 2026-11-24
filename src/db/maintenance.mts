import type { Pool } from "pg";

import { PhisSupportTicketStatus } from "@phis/contracts/support";
import { PhisMediaSpaceKind } from "../lib/constants/media-space-kinds.ts";
import { SUPPORT_TICKET_EVENT_CLOSED } from "../lib/constants/support.ts";
import { sweepPhisAddonAssets } from "./server-addon-asset-sweep.mts";
import { supportTicketWindowEndSql, supportTicketWindowPassedSql } from "./support-requester-window.mts";

/**
 * The cleanup steps nobody waits for, written once.
 *
 * Two callers run each of these and neither owns the logic: the Core job of the same name
 * (`src/lib/jobs/core-jobs.ts`), which the clock starts, and the task of `phis maintain`
 * (`src/cli/maintain.mts`), which an operator starts by hand. Both hand in the pool, so the statements,
 * the windows and the bounds exist here and nowhere else.
 *
 * Every step is bounded, answers `dryRun` without changing anything, gives the same answer run twice,
 * and may run on two instances at once. A step that walks in a loop looks at `signal` between its
 * statements and stops there, so a run the scheduler gave up on does not go on in the background.
 */

export type PhiMaintenanceOutcome = {
  /** What it dealt with. Zero is the ordinary answer and is not a failure. */
  cleared: number;
  detail: string;
};

export type PhiMaintenanceStepOptions = {
  dryRun?: boolean;
  /** The scheduler's abort signal; the CLI has none. */
  signal?: AbortSignal;
};

/** Rows removed per statement, and statements per table per run: 50 000 rows, then the next run goes on. */
const PHI_MAINTENANCE_BATCH_ROWS = 1000;
const PHI_MAINTENANCE_MAX_BATCHES = 50;

/**
 * The users:v1 access log past each Site's retention (`sites.users_access_log_days`, 90 days unless the
 * operator set another with `phis site set --users-access-log-days`), oldest first and in batches.
 */
export async function forgetExpiredPhisUsersAccessLog(
  pool: Pool,
  { dryRun = false, signal }: PhiMaintenanceStepOptions = {},
): Promise<PhiMaintenanceOutcome> {
  const expired = `l.created_at < NOW() - make_interval(days => s.users_access_log_days)`;
  if (dryRun) {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM phis.users_access_log l
         JOIN phis.sites s ON s.id = l.site_id
        WHERE ${expired}`,
    );
    const count = Number(rows[0]?.count ?? "0");
    return { cleared: 0, detail: `Would forget ${count} access log entr${count === 1 ? "y" : "ies"} past their Site's retention.` };
  }
  let cleared = 0;
  let more = false;
  for (let batch = 0; batch < PHI_MAINTENANCE_MAX_BATCHES; batch += 1) {
    if (signal?.aborted) break;
    const { rowCount } = await pool.query(
      `DELETE FROM phis.users_access_log
        WHERE id IN (
          SELECT l.id FROM phis.users_access_log l
            JOIN phis.sites s ON s.id = l.site_id
           WHERE ${expired}
           ORDER BY l.id
           LIMIT $1::int
             FOR UPDATE OF l SKIP LOCKED)`,
      [PHI_MAINTENANCE_BATCH_ROWS],
    );
    const removed = rowCount ?? 0;
    cleared += removed;
    if (removed < PHI_MAINTENANCE_BATCH_ROWS) break;
    if (batch === PHI_MAINTENANCE_MAX_BATCHES - 1) more = true;
  }
  return {
    cleared,
    detail: cleared === 0
      ? "Nothing past its Site's retention."
      : `${cleared} access log entr${cleared === 1 ? "y" : "ies"}${more ? "; more may be due, run again" : ""}.`,
  };
}

/**
 * Reservations of uploads that were never completed, across every Space.
 *
 * The request path already releases these for the Space it is reserving against, and the reader already
 * discounts an expired reservation, so nothing is blocked by one lying around -- which is exactly why
 * this is a step of its own and not part of a request. What it repairs is the figure, for a Space nobody
 * has uploaded into since.
 *
 * An expired session is dead whoever was holding it: the expiry has passed, so there is no transfer in
 * flight it could belong to, and any instance may remove one.
 */
export async function releaseExpiredPhisUploadSessions(
  pool: Pool,
  { dryRun = false, signal }: PhiMaintenanceStepOptions = {},
): Promise<PhiMaintenanceOutcome> {
  if (dryRun) {
    const { rows } = await pool.query<{ count: string; bytes: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(SUM(size_bytes), 0)::text AS bytes
         FROM phis.media_upload_sessions WHERE expires_at < NOW()`,
    );
    const count = Number(rows[0]?.count ?? 0);
    return { cleared: count, detail: `${count} session(s) holding ${rows[0]?.bytes ?? 0} bytes.` };
  }
  /*
   * One statement per batch, and in it the sessions and the Space's figure together, so a concurrent
   * reservation can never observe the rows gone and their bytes still counted. Grouped first because
   * `reserved_bytes` is per Space and the sessions are not. `SKIP LOCKED` so two runs at once take
   * different rows instead of waiting on each other.
   */
  let sessions = 0;
  let bytes = 0;
  const spaces = new Set<number>();
  let more = false;
  for (let batch = 0; batch < PHI_MAINTENANCE_MAX_BATCHES; batch += 1) {
    if (signal?.aborted) break;
    const { rows } = await pool.query<{ space_id: number; bytes: string; sessions: number }>(
      `WITH expired AS (
         DELETE FROM phis.media_upload_sessions
          WHERE token IN (
            SELECT token FROM phis.media_upload_sessions
             WHERE expires_at < NOW()
             ORDER BY expires_at
             LIMIT $1::int
               FOR UPDATE SKIP LOCKED)
          RETURNING space_id, size_bytes
       ), per_space AS (
         SELECT space_id, SUM(size_bytes)::bigint AS bytes, COUNT(*)::int AS sessions
           FROM expired GROUP BY space_id
       ), released AS (
         UPDATE phis.media_spaces s
            SET reserved_bytes = GREATEST(0, s.reserved_bytes - p.bytes), updated_at = NOW()
           FROM per_space p WHERE s.id = p.space_id
         RETURNING s.id
       )
       SELECT space_id, bytes::text, sessions FROM per_space`,
      [PHI_MAINTENANCE_BATCH_ROWS],
    );
    let removed = 0;
    for (const row of rows) {
      removed += row.sessions;
      bytes += Number(row.bytes);
      spaces.add(row.space_id);
    }
    sessions += removed;
    if (removed < PHI_MAINTENANCE_BATCH_ROWS) break;
    if (batch === PHI_MAINTENANCE_MAX_BATCHES - 1) more = true;
  }
  return {
    cleared: sessions,
    detail: sessions === 0
      ? "Nothing had run out."
      : `${sessions} session(s) across ${spaces.size} Space(s), giving back ${bytes} bytes${
        more ? "; more may be due, run again" : ""
      }.`,
  };
}

/**
 * Files in an Add-on's Space that no row of that Add-on names any more.
 *
 * They arise because the cascade only runs one way: removing an Add-on's parent row takes the rows
 * linking its files, and a Media Asset is not the Add-on's to cascade. Nothing is waiting for these
 * either -- they cost space and no request needs them gone.
 *
 * The rows go and the objects are counted, not removed. Reaching a store means building a Provider from
 * an installed Add-on, which is a bucket lifecycle rule for S3 and a deliberate operator command for
 * Local -- `phis addon storage --sweep` is that command, and it names one Add-on on one Site. Rows first
 * is also the order that cannot lose anything: what a failed removal leaves is a file nobody names,
 * which is precisely what the next run looks for.
 *
 * Bounded by the number of Add-on Spaces, one pass each; the loop stops between two Spaces when the
 * signal says so.
 */
export async function collectOrphanedPhisAddonAssets(
  pool: Pool,
  { dryRun = false, signal }: PhiMaintenanceStepOptions = {},
): Promise<PhiMaintenanceOutcome> {
  const { rows: spaces } = await pool.query<{
    site_id: number; site_key: string; addon_id: string;
  }>(
    `SELECT sp.site_id, s.key AS site_key, sp.addon_id
       FROM phis.media_spaces sp
       JOIN phis.sites s ON s.id = sp.site_id
      WHERE sp.kind = $1 AND sp.addon_id IS NOT NULL
      ORDER BY s.key, sp.addon_id`,
    [PhisMediaSpaceKind.Addon],
  );
  if (dryRun) {
    // Counting would mean running the same join for its answer, which is the work itself. What is
    // cheap and honest is saying where it would look.
    return {
      cleared: 0,
      detail: `Would examine ${spaces.length} Add-on Space(s).`,
    };
  }
  let cleared = 0;
  const keys: string[] = [];
  for (const space of spaces) {
    if (signal?.aborted) break;
    const result = await sweepPhisAddonAssets(pool, {
      addonId: space.addon_id, siteId: space.site_id, siteKey: space.site_key,
    });
    cleared += result.orphaned;
    keys.push(...result.storageKeys);
  }
  return {
    cleared,
    detail: cleared === 0
      ? `Nothing unreferenced across ${spaces.length} Add-on Space(s).`
      : `${cleared} file(s) across ${spaces.length} Add-on Space(s). ` +
        `${keys.length} object(s) are now unreferenced; phis addon storage --sweep removes those.`,
  };
}

/**
 * The record of webhook deliveries that no sender will retry any more.
 *
 * Core writes one row per signed delivery so a retry is recognised as one rather than becoming a second
 * message in somebody's thread. A sender gives up after days; the row is worth nothing after that, and
 * keeping it costs a row per delivery forever.
 *
 * The window is deliberately far past any sender's: the cost of holding one too long is a row, and the
 * cost of dropping one too early is a duplicate that will look like the Add-on's fault.
 */
export const PHI_HOOK_DELIVERY_RETENTION_DAYS = 30;

export async function forgetSettledPhisHookDeliveries(
  pool: Pool,
  { dryRun = false, signal }: PhiMaintenanceStepOptions = {},
): Promise<PhiMaintenanceOutcome> {
  if (dryRun) {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM phis.addon_hook_deliveries
        WHERE received_at < NOW() - make_interval(days => $1::int)`,
      [PHI_HOOK_DELIVERY_RETENTION_DAYS],
    );
    const count = Number(rows[0]?.count ?? "0");
    return {
      cleared: 0,
      detail: `Would forget ${count} delivery record(s) older than ${PHI_HOOK_DELIVERY_RETENTION_DAYS} day(s).`,
    };
  }
  const key = "addon_id, delivery_id";
  let cleared = 0;
  let more = false;
  for (let batch = 0; batch < PHI_MAINTENANCE_MAX_BATCHES; batch += 1) {
    if (signal?.aborted) break;
    const { rowCount } = await pool.query(
      `DELETE FROM phis.addon_hook_deliveries
        WHERE (${key}) IN (
          SELECT ${key} FROM phis.addon_hook_deliveries
           WHERE received_at < NOW() - make_interval(days => $1::int)
           ORDER BY received_at
           LIMIT $2::int
             FOR UPDATE SKIP LOCKED)`,
      [PHI_HOOK_DELIVERY_RETENTION_DAYS, PHI_MAINTENANCE_BATCH_ROWS],
    );
    const removed = rowCount ?? 0;
    cleared += removed;
    if (removed < PHI_MAINTENANCE_BATCH_ROWS) break;
    if (batch === PHI_MAINTENANCE_MAX_BATCHES - 1) more = true;
  }
  return {
    cleared,
    detail: cleared === 0
      ? `Nothing older than ${PHI_HOOK_DELIVERY_RETENTION_DAYS} day(s).`
      : `${cleared} delivery record(s)${more ? "; more may be due, run again" : ""}.`,
  };
}

/**
 * Resolved tickets whose requester stayed silent for the whole window, written down as closed.
 *
 * Nothing waits for this. Every read already shows such a ticket as closed, and every write that locks
 * one records the close before it acts (`src/db/support-requester-window.mts`), so a Site whose operator
 * never runs it loses nothing. What it repairs is the stored row of a ticket nobody touches again, so
 * that the column means what it says to anything reading the table directly.
 *
 * The window is the ticket type's, else the Site's. A Site at `0` has switched automatic closing off for
 * every type at once, and a type at `0` waits for a Supporter. A ticket nobody asked for -- opened by
 * Staff or an integration with no requester -- has nobody to wait for and is closed by a Supporter.
 *
 * Bounded at 500 tickets a run, oldest resolution first, and `SKIP LOCKED`, so two runs at once close
 * each ticket once and a ticket somebody is answering right now is left to the next run.
 */
export async function closePhisSupportTicketsPastRequesterWindow(
  pool: Pool,
  { dryRun = false }: PhiMaintenanceStepOptions = {},
): Promise<PhiMaintenanceOutcome> {
  // The stored status narrows it to resolved tickets; the shared expression decides which are due.
  const due = `
    SELECT ticket.id
      FROM phis.support_tickets ticket
     WHERE ticket.status = ${PhisSupportTicketStatus.Resolved}
       AND ${supportTicketWindowPassedSql("ticket")}
     ORDER BY ticket.resolved_at ASC
     LIMIT 500`;
  if (dryRun) {
    const { rows } = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM (${due}) due`);
    const count = rows[0]?.count ?? 0;
    return { cleared: count, detail: `${count} ticket(s) past their requester window.` };
  }
  const { rows } = await pool.query<{ count: number }>(
    `WITH due AS (${due} FOR UPDATE OF ticket SKIP LOCKED),
     closed AS (
       UPDATE phis.support_tickets ticket
          SET status = ${PhisSupportTicketStatus.Closed}, closed_at = ${supportTicketWindowEndSql("ticket")},
              updated_by_user_id = NULL, updated_at = NOW()
         FROM due
        WHERE ticket.id = due.id
       RETURNING ticket.id
     ),
     recorded AS (
       INSERT INTO phis.support_ticket_events (ticket_id, event_type, payload, created_by_user_id)
       SELECT id, ${SUPPORT_TICKET_EVENT_CLOSED},
              jsonb_build_object('fromStatus', ${PhisSupportTicketStatus.Resolved},
                                 'toStatus', ${PhisSupportTicketStatus.Closed},
                                 'reason', 'requester_window'),
              NULL
         FROM closed
     )
     SELECT COUNT(*)::int AS count FROM closed`,
  );
  const count = rows[0]?.count ?? 0;
  return {
    cleared: count,
    detail: count === 0
      ? "No resolved ticket was past its window."
      : `${count} ticket(s) closed${count === 500 ? "; more may be due, run again" : ""}.`,
  };
}

/**
 * How long a settled row of the three queues stays, counted from the moment it settled.
 *
 * Only a row that reached an end state is ever a candidate; what is still owed stays however old it is.
 * The end states are the ones the writers set themselves: `notification_outbox.sent_at`,
 * `payment_notification_receipts.processed` with `processed_at`, and `addon_event_outbox.delivered_at`.
 * A mail dropped because consent was withdrawn (`flags & 2`) or given up after its attempts ran out, and
 * an event that keeps failing, are not in that list and are left for an operator to look at.
 *
 * What an old row still does is remember a key: a `dedupeKey` of the same Site, or a Provider's delivery
 * id, is only recognised while its row exists. A sender retries for days, and a job repeats within
 * minutes; the windows are far past both.
 */
const PHI_NOTIFICATION_SENT_RETENTION_DAYS = 90;
const PHI_PAYMENT_RECEIPT_RETENTION_DAYS = 90;
const PHI_ADDON_EVENT_DELIVERED_RETENTION_DAYS = 30;

type PhiRetentionTarget = {
  table: string;
  days: number;
  /** The key columns, so a batch can name its rows. */
  key: string;
  /** The rows that are settled and past the window, with `$1` as the window in days. */
  expired: string;
  order: string;
};

const PHI_RETENTION_TARGETS: readonly PhiRetentionTarget[] = [
  {
    table: "notification_outbox",
    days: PHI_NOTIFICATION_SENT_RETENTION_DAYS,
    key: "id",
    expired: "sent_at IS NOT NULL AND sent_at < NOW() - make_interval(days => $1::int)",
    order: "sent_at",
  },
  {
    table: "payment_notification_receipts",
    days: PHI_PAYMENT_RECEIPT_RETENTION_DAYS,
    key: "site_id, profile_key, delivery_id",
    expired: "processed AND processed_at IS NOT NULL AND processed_at < NOW() - make_interval(days => $1::int)",
    order: "processed_at",
  },
  {
    table: "addon_event_outbox",
    days: PHI_ADDON_EVENT_DELIVERED_RETENTION_DAYS,
    key: "id",
    expired: "delivered_at IS NOT NULL AND delivered_at < NOW() - make_interval(days => $1::int)",
    order: "delivered_at",
  },
];

export async function forgetSettledPhisQueueRows(
  pool: Pool,
  { dryRun = false, signal }: PhiMaintenanceStepOptions = {},
): Promise<PhiMaintenanceOutcome> {
  const parts: string[] = [];
  let total = 0;
  let more = false;
  for (const target of PHI_RETENTION_TARGETS) {
    let count = 0;
    if (dryRun) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM phis.${target.table} WHERE ${target.expired}`,
        [target.days],
      );
      count = Number(rows[0]?.count ?? "0");
    } else {
      // `SKIP LOCKED` so two runs at once take different rows instead of waiting on each other.
      const statement = `DELETE FROM phis.${target.table}
        WHERE (${target.key}) IN (
          SELECT ${target.key} FROM phis.${target.table}
           WHERE ${target.expired}
           ORDER BY ${target.order}
           LIMIT $2::int
             FOR UPDATE SKIP LOCKED)`;
      for (let batch = 0; batch < PHI_MAINTENANCE_MAX_BATCHES; batch += 1) {
        if (signal?.aborted) break;
        const { rowCount } = await pool.query(statement, [target.days, PHI_MAINTENANCE_BATCH_ROWS]);
        const removed = rowCount ?? 0;
        count += removed;
        if (removed < PHI_MAINTENANCE_BATCH_ROWS) break;
        if (batch === PHI_MAINTENANCE_MAX_BATCHES - 1) more = true;
      }
    }
    total += count;
    parts.push(`${target.table} ${count} (older than ${target.days} day(s))`);
  }
  return {
    cleared: total,
    detail: `${dryRun ? "Would forget" : "Forgot"} ${parts.join(", ")}${more ? "; more may be due, run again" : ""}.`,
  };
}
