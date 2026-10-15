import type { Pool } from "pg";

import { sweepPhisAddonAssets } from "./storage-sweep.mts";
import {
  readPhisAddonStorageSites,
  recountPhisAddonStorage,
  type PhisAddonStorageSite,
} from "./storage-purge.mts";
import { readPhisAddonStorageUsage } from "../db/server-addon-storage-usage.mts";
import { PhisMediaSpaceKind } from "../lib/constants/media-space-kinds.ts";
import { SUPPORT_TICKET_EVENT_CLOSED } from "../lib/constants/support.ts";
import { PhisSupportTicketStatus } from "@phis/contracts/support";
import { supportTicketWindowEndSql, supportTicketWindowPassedSql } from "../db/support-requester-window.mts";

/**
 * The one place cleanup lives, and the reason there is only one.
 *
 * `AGENTS.md` draws the line this file sits on. Cleanup that a request needs the result of belongs to
 * that request, inside the transaction it already has open -- an expired upload reservation is released
 * when the same Media Space is next reserved against, and a reader discounts what a writer has not got
 * to yet. No background timer, no in-process scheduler, no election between instances.
 *
 * What is left over is the other category the same contract names and blesses: **operator-invoked,
 * bounded, reporting operations**, whose home is `phis`. That is what this is. Every task here shares
 * three properties, and a new one has to have them too:
 *
 * - **Nobody is waiting for it.** If a request needs the result, it is that request's job, not this
 *   one's. A task here repairs a figure or removes something nothing points at.
 * - **It is bounded.** It states what it looked at and what it did, and it does not walk something
 *   unbounded without saying so.
 * - **Running it twice is running it once.** An operator may run it whenever, and two instances may run
 *   it at the same moment.
 *
 * Adding one means adding an entry to `PHI_MAINTENANCE_TASKS`. Nothing else changes: `phis maintain`
 * lists it, runs it, and reports it, and `--dry-run` asks it what it would do.
 */

export type PhiMaintenanceReport = {
  id: string;
  /** What it dealt with. Zero is the ordinary answer and is not a failure. */
  cleared: number;
  detail: string;
  error: string | null;
};

/**
 * A listing of one Site's store, or `null` where this process cannot reach the Provider.
 *
 * Handed in by the CLI rather than built here: opening a store needs the configuration root and the
 * secret key, which are the command's to hold, and a test hands in a listing of its own.
 */
export type PhiMaintenanceStoreOpener = (
  site: PhisAddonStorageSite,
) => Promise<{ listPrefix(prefix: string): Promise<{ storageKey: string; byteSize: number }[]> } | null>;

export type PhiMaintenanceContext = {
  dryRun: boolean;
  openStore?: PhiMaintenanceStoreOpener;
  recoverPayments?: (dryRun: boolean) => Promise<{ cleared: number; detail: string }>;
};

export type PhiMaintenanceTask = {
  id: string;
  summary: string;
  /**
   * Does the work, or -- with `dryRun` -- reports what it would have done without doing it.
   *
   * A task that cannot answer the dry-run question cheaply says so in its detail rather than doing the
   * work anyway. An operator running `--dry-run` has said they do not want anything changed.
   */
  run(pool: Pool, options: PhiMaintenanceContext): Promise<{ cleared: number; detail: string }>;
};

/**
 * Reservations of uploads that were never completed, across every Space.
 *
 * The request path already releases these for the Space it is reserving against, and the reader already
 * discounts an expired reservation, so nothing is blocked by one lying around -- which is exactly why
 * this belongs here and not on a timer. What it repairs is the figure, for a Space nobody has uploaded
 * into since, and the staged objects those sessions left.
 *
 * An expired session is dead whoever was holding it: the expiry has passed, so there is no transfer in
 * flight it could belong to, and any instance may remove one.
 */
const expiredUploadSessions: PhiMaintenanceTask = {
  id: "upload-sessions",
  summary: "Release the reservations of upload sessions that ran out.",
  async run(pool, { dryRun }) {
    if (dryRun) {
      const { rows } = await pool.query<{ count: string; bytes: string }>(
        `SELECT COUNT(*)::text AS count, COALESCE(SUM(size_bytes), 0)::text AS bytes
           FROM phis.media_upload_sessions WHERE expires_at < NOW()`,
      );
      const count = Number(rows[0]?.count ?? 0);
      return { cleared: count, detail: `${count} session(s) holding ${rows[0]?.bytes ?? 0} bytes.` };
    }
    /*
     * One statement per Space, so a concurrent reservation can never observe the rows gone and their
     * bytes still counted. Grouped first because `reserved_bytes` is per Space and the sessions are not.
     */
    const { rows } = await pool.query<{ space_id: number; bytes: string; sessions: number }>(
      `WITH expired AS (
         DELETE FROM phis.media_upload_sessions
          WHERE expires_at < NOW()
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
    );
    const sessions = rows.reduce((total, row) => total + row.sessions, 0);
    const bytes = rows.reduce((total, row) => total + Number(row.bytes), 0);
    return {
      cleared: sessions,
      detail: sessions === 0
        ? "Nothing had run out."
        : `${sessions} session(s) across ${rows.length} Space(s), giving back ${bytes} bytes.`,
    };
  },
};

/**
 * Files in an Add-on's Space that no row of that Add-on names any more.
 *
 * They arise because the cascade only runs one way: removing an Add-on's parent row takes the rows
 * linking its files, and a Media Asset is not the Add-on's to cascade. Nothing is waiting for these
 * either -- they cost space and no request needs them gone -- which is what puts them here.
 *
 * The rows go and the objects are counted, not removed. That is the same contract talking: reaching a
 * store means building a Provider from an installed Add-on, which is a bucket lifecycle rule for S3 and
 * a deliberate operator command for Local -- `phis addon storage --sweep` is that command, and it names
 * one Add-on on one Site. Rows first is also the order that cannot lose anything: what a failed removal
 * leaves is a file nobody names, which is precisely what the next run looks for.
 */
const orphanedAddonAssets: PhiMaintenanceTask = {
  id: "addon-assets",
  summary: "Collect the files of an Add-on that nothing links to any more.",
  async run(pool, { dryRun }) {
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
  },
};

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
const PHI_HOOK_DELIVERY_RETENTION_DAYS = 30;

const settledHookDeliveries: PhiMaintenanceTask = {
  id: "hook-deliveries",
  summary: "Forget webhook deliveries nobody will retry.",
  async run(pool, { dryRun }) {
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
    const { rowCount } = await pool.query(
      `DELETE FROM phis.addon_hook_deliveries
        WHERE received_at < NOW() - make_interval(days => $1::int)`,
      [PHI_HOOK_DELIVERY_RETENTION_DAYS],
    );
    const cleared = rowCount ?? 0;
    return {
      cleared,
      detail: cleared === 0
        ? `Nothing older than ${PHI_HOOK_DELIVERY_RETENTION_DAYS} day(s).`
        : `${cleared} delivery record(s).`,
    };
  },
};

/**
 * The storage counters of every Add-on store, set to what the stores actually hold.
 *
 * `put` books before it writes and reads "is the key already there" first, so two writes of one new key
 * at the same moment -- a retried request, an event delivered twice, a job on two instances -- both
 * book an object and one object lands. Other drift has the same shape: an object removed with a bucket
 * client, a Provider migration. Preventing the first would cost every write a lock or a row per object
 * for a rare case; counting again repairs all of them, which is why it is here.
 *
 * It lists each store once, so it costs what the stores hold, and says so. A write in flight while a
 * store is listed is booked but not yet there and is left out of the figure; that errs towards room, and
 * the next run counts it.
 */
const addonStorageCounters: PhiMaintenanceTask = {
  id: "addon-storage",
  summary: "Recount what every Add-on store holds and correct its storage counters.",
  async run(pool, { dryRun, openStore }) {
    const { rows } = await pool.query<{ addon_id: string }>(
      `SELECT DISTINCT addon_id FROM phis.site_server_addons ORDER BY addon_id`,
    );
    const stores = (await Promise.all(rows.map(async ({ addon_id: addonId }) =>
      (await readPhisAddonStorageSites(pool, addonId)).map((site) => ({ addonId, site }))
    ))).flat();
    if (dryRun || !openStore) {
      return {
        cleared: 0,
        detail: `Would list ${stores.length} Add-on store(s)` +
          (openStore ? "." : "; this run has no access to the stores."),
      };
    }
    let corrected = 0;
    const unreachable: string[] = [];
    for (const { addonId, site } of stores) {
      const store = await openStore(site);
      if (!store) {
        unreachable.push(`${addonId}@${site.siteKey}`);
        continue;
      }
      const before = await readPhisAddonStorageUsage(pool, { addonId, siteId: site.siteId });
      const after = await recountPhisAddonStorage(pool, {
        addonId, site, listPrefix: (prefix) => store.listPrefix(prefix),
      });
      if (after.bytes !== before.bytes || after.objects !== before.objects) {
        corrected += 1;
      }
    }
    return {
      cleared: corrected,
      detail: `Listed ${stores.length - unreachable.length} of ${stores.length} store(s); ` +
        `${corrected} counter(s) corrected.` +
        (unreachable.length > 0 ? ` Not reachable from here: ${unreachable.join(", ")}.` : ""),
    };
  },
};

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
const supportRequesterWindow: PhiMaintenanceTask = {
  id: "support-requester-window",
  summary: "Close resolved tickets whose requester did not answer within the window.",
  async run(pool, { dryRun }) {
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
  },
};

/** Ordered as they run. A task must not depend on an earlier one having run first. */
export const PHI_MAINTENANCE_TASKS: readonly PhiMaintenanceTask[] = Object.freeze([
  { id: "payments", summary: "Reconcile up to 100 unresolved Payment operations without replaying financial commands.",
    async run(_pool, { dryRun, recoverPayments }) {
      if (!recoverPayments) return { cleared: 0, detail: "This invocation has no Payment Provider resolver." };
      return recoverPayments(dryRun);
    },
  },
  expiredUploadSessions,
  orphanedAddonAssets,
  settledHookDeliveries,
  addonStorageCounters,
  supportRequesterWindow,
]);

/**
 * Runs the tasks and reports each one.
 *
 * A task that throws is reported and the run continues. An operator invoking this wants the state of
 * everything, and stopping at the first unreachable thing would hide the rest behind it.
 */
export async function runPhiMaintenance(
  pool: Pool,
  options: { only?: string | null; dryRun?: boolean; openStore?: PhiMaintenanceStoreOpener; recoverPayments?: PhiMaintenanceContext["recoverPayments"] } = {},
): Promise<PhiMaintenanceReport[]> {
  const dryRun = options.dryRun === true;
  const only = options.only?.trim() || null;
  if (only && !PHI_MAINTENANCE_TASKS.some((task) => task.id === only)) {
    throw new Error(
      `"${only}" is not a maintenance task. Known: ${
        PHI_MAINTENANCE_TASKS.map((task) => task.id).join(", ")
      }.`,
    );
  }
  const reports: PhiMaintenanceReport[] = [];
  for (const task of PHI_MAINTENANCE_TASKS) {
    if (only && task.id !== only) {
      continue;
    }
    try {
      const result = await task.run(pool, { dryRun, openStore: options.openStore, recoverPayments: options.recoverPayments });
      reports.push({ id: task.id, cleared: result.cleared, detail: result.detail, error: null });
    } catch (error) {
      reports.push({
        id: task.id,
        cleared: 0,
        detail: "",
        error: error instanceof Error ? error.message.trim() : "no reason given",
      });
    }
  }
  return reports;
}
