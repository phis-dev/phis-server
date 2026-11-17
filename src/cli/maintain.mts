import type { Pool } from "pg";

import {
  readPhisAddonStorageSites,
  recountPhisAddonStorage,
  type PhisAddonStorageSite,
} from "./storage-purge.mts";
import { readPhisAddonStorageUsage } from "../db/server-addon-storage-usage.mts";
import {
  closePhisSupportTicketsPastRequesterWindow,
  collectOrphanedPhisAddonAssets,
  forgetSettledPhisHookDeliveries,
  forgetSettledPhisQueueRows,
  releaseExpiredPhisUploadSessions,
} from "../db/maintenance.mts";

/**
 * `phis maintain`: the same cleanup the server's clock runs, started by hand, and the steps too heavy
 * for the server process.
 *
 * `AGENTS.md` draws the line. Cleanup that a request needs the result of belongs to that request, inside
 * the transaction it already has open. Cleanup that nobody waits for is a Core job on the scheduler
 * (`src/lib/jobs/core-jobs.ts`), and what this file does with those is run the very same function: each
 * of those tasks is one call into `src/db/maintenance.mts` (or `reconcilePhisPayments`), which the job
 * calls too. So an operator who wants the answer now, or wants to see what a run would do with
 * `--dry-run`, gets the job's behaviour and not a second copy of it. The one task the clock does not run
 * is `addon-storage`, which lists every store in full and so costs what the stores hold -- too heavy for
 * the server process, and needs the configuration root and the secret key, which only this command holds.
 *
 * Every task here shares three properties, and a new one has to have them too:
 *
 * - **Nobody is waiting for it.** If a request needs the result, it is that request's job, not this
 *   one's. A task here repairs a figure or removes something nothing points at.
 * - **It is bounded.** It states what it looked at and what it did, and it does not walk something
 *   unbounded without saying so.
 * - **Running it twice is running it once.** An operator may run it whenever, and two instances may run
 *   it at the same moment.
 *
 * Adding one means adding an entry to `PHI_MAINTENANCE_TASKS`. Nothing else changes: `phis maintain`
 * lists it, runs it, and reports it, and `--dry-run` asks it what it would do. A task that is also to run
 * on the clock gets a Core job that calls the same function.
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

/** Ordered as they run. A task must not depend on an earlier one having run first. */
export const PHI_MAINTENANCE_TASKS: readonly PhiMaintenanceTask[] = Object.freeze([
  { id: "payments", summary: "Reconcile up to 100 unresolved Payment operations without replaying financial commands.",
    async run(_pool, { dryRun, recoverPayments }) {
      if (!recoverPayments) return { cleared: 0, detail: "This invocation has no Payment Provider resolver." };
      return recoverPayments(dryRun);
    },
  },
  {
    id: "upload-sessions",
    summary: "Release the reservations of upload sessions that ran out.",
    run: (pool, { dryRun }) => releaseExpiredPhisUploadSessions(pool, { dryRun }),
  },
  {
    id: "addon-assets",
    summary: "Collect the files of an Add-on that nothing links to any more.",
    run: (pool, { dryRun }) => collectOrphanedPhisAddonAssets(pool, { dryRun }),
  },
  {
    id: "hook-deliveries",
    summary: "Forget webhook deliveries nobody will retry.",
    run: (pool, { dryRun }) => forgetSettledPhisHookDeliveries(pool, { dryRun }),
  },
  {
    id: "queue-retention",
    summary: "Forget sent mails, processed payment receipts and delivered Add-on events past their window.",
    run: (pool, { dryRun }) => forgetSettledPhisQueueRows(pool, { dryRun }),
  },
  addonStorageCounters,
  {
    id: "support-requester-window",
    summary: "Close resolved tickets whose requester did not answer within the window.",
    run: (pool, { dryRun }) => closePhisSupportTicketsPastRequesterWindow(pool, { dryRun }),
  },
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
