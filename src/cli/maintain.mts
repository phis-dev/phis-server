import type { Pool } from "pg";

import { sweepPhiServerAddonAssets } from "./storage-sweep.mts";

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

export type PhiMaintenanceTask = {
  id: string;
  summary: string;
  /**
   * Does the work, or -- with `dryRun` -- reports what it would have done without doing it.
   *
   * A task that cannot answer the dry-run question cheaply says so in its detail rather than doing the
   * work anyway. An operator running `--dry-run` has said they do not want anything changed.
   */
  run(pool: Pool, options: { dryRun: boolean }): Promise<{ cleared: number; detail: string }>;
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
        WHERE sp.kind = 4 AND sp.addon_id IS NOT NULL
        ORDER BY s.key, sp.addon_id`,
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
      const result = await sweepPhiServerAddonAssets(pool, {
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

/** Ordered as they run. A task must not depend on an earlier one having run first. */
export const PHI_MAINTENANCE_TASKS: readonly PhiMaintenanceTask[] = Object.freeze([
  expiredUploadSessions,
  orphanedAddonAssets,
]);

/**
 * Runs the tasks and reports each one.
 *
 * A task that throws is reported and the run continues. An operator invoking this wants the state of
 * everything, and stopping at the first unreachable thing would hide the rest behind it.
 */
export async function runPhiMaintenance(
  pool: Pool,
  options: { only?: string | null; dryRun?: boolean } = {},
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
      const result = await task.run(pool, { dryRun });
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
