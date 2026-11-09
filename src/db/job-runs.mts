import type { Pool, PoolClient } from "pg";

import { PhiJobRunFlag, PhiJobStateFlag } from "../lib/constants/jobs.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * The scheduler's ledger (DB.md, `phis.job_runs` and `phis.job_states`).
 *
 * Every function here is one statement, and the statement is the rule. A moment is claimed by inserting
 * its row; the unique key refuses the second claimant, so the database decides who runs and no instance
 * has to ask another. A lease on the row says the runner is alive; a row whose lease ran out unfinished
 * is one another instance may take. The state row is the operator's switch and the last outcome, kept
 * after the run rows are pruned.
 */

export type PhiJobKey = {
  /** An Add-on id, or `@phis/server` for Core's own jobs. */
  owner: string;
  jobId: string;
  /** `null` for a job that runs for the stage rather than for one Site. */
  siteId: number | null;
};

export type PhiJobRunRecord = {
  id: string;
  owner: string;
  jobId: string;
  siteId: number | null;
  slotAt: string;
  instanceId: string;
  startedAt: string;
  lockedUntil: string;
  finishedAt: string | null;
  flags: number;
  error: string | null;
};

export type PhiJobStateRecord = PhiJobKey & {
  flags: number;
  lastSlotAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

type RunRow = {
  id: string;
  owner: string;
  job_id: string;
  site_id: number | null;
  slot_at: string;
  instance_id: string;
  started_at: string;
  locked_until: string;
  finished_at: string | null;
  flags: number;
  error: string | null;
};

const RUN_COLUMNS = "id, owner, job_id, site_id, slot_at, instance_id, started_at, locked_until, finished_at, flags, error";

function mapRun(row: RunRow): PhiJobRunRecord {
  return {
    id: row.id,
    owner: row.owner,
    jobId: row.job_id,
    siteId: row.site_id,
    slotAt: row.slot_at,
    instanceId: row.instance_id,
    startedAt: row.started_at,
    lockedUntil: row.locked_until,
    finishedAt: row.finished_at,
    flags: row.flags,
    error: row.error,
  };
}

/**
 * Claims one moment for this instance, or learns that it is not this instance's to run.
 *
 * `claimed` carries the new row. `taken` means another instance holds the moment already, or the job
 * is paused. `skipped` means the previous moment's run is still going under a live lease: the moment is
 * recorded as skipped, finished on the spot, so that a slow job never runs beside itself and the ledger
 * shows the moment it missed. One statement, so two instances claiming at once see one row.
 */
export async function claimPhiJobSlot(
  db: Queryable,
  input: PhiJobKey & { slotAt: Date; instanceId: string; leaseMs: number; manual?: boolean },
): Promise<{ outcome: "claimed" | "skipped"; run: PhiJobRunRecord } | { outcome: "taken" }> {
  const { rows } = await db.query<RunRow & { paused: boolean; overran: boolean }>(
    `WITH paused AS (
       SELECT (flags & $8) <> 0 AS paused
       FROM phis.job_states
       WHERE owner = $1 AND job_id = $2 AND COALESCE(site_id, 0) = COALESCE($3::smallint, 0)
     ),
     running AS (
       SELECT 1
       FROM phis.job_runs
       WHERE owner = $1 AND job_id = $2 AND COALESCE(site_id, 0) = COALESCE($3::smallint, 0)
         AND finished_at IS NULL
         AND locked_until > NOW()
       LIMIT 1
     ),
     inserted AS (
       INSERT INTO phis.job_runs (owner, job_id, site_id, slot_at, instance_id, locked_until, finished_at, flags, error)
       SELECT $1, $2, $3::smallint, $4::timestamptz, $5,
              CASE WHEN EXISTS (SELECT 1 FROM running) THEN NOW() ELSE NOW() + ($6::int * INTERVAL '1 millisecond') END,
              CASE WHEN EXISTS (SELECT 1 FROM running) THEN NOW() ELSE NULL END,
              CASE WHEN EXISTS (SELECT 1 FROM running) THEN $9::int ELSE $7::int END,
              CASE WHEN EXISTS (SELECT 1 FROM running) THEN 'The previous moment''s run was still going.' ELSE NULL END
       WHERE NOT COALESCE((SELECT paused FROM paused), FALSE)
       ON CONFLICT DO NOTHING
       RETURNING ${RUN_COLUMNS}
     )
     SELECT inserted.*, COALESCE((SELECT paused FROM paused), FALSE) AS paused, EXISTS (SELECT 1 FROM running) AS overran
     FROM inserted`,
    [
      input.owner,
      input.jobId,
      input.siteId,
      input.slotAt,
      input.instanceId,
      input.leaseMs,
      input.manual ? PhiJobRunFlag.Manual : 0,
      PhiJobStateFlag.Paused,
      PhiJobRunFlag.Skipped | (input.manual ? PhiJobRunFlag.Manual : 0),
    ],
  );
  const row = rows[0];
  if (!row) {
    return { outcome: "taken" };
  }
  const run = mapRun(row);
  return { outcome: (run.flags & PhiJobRunFlag.Skipped) !== 0 ? "skipped" : "claimed", run };
}

/** Renews the runner's lease; answers false when the row is no longer this instance's to renew. */
export async function renewPhiJobLease(
  db: Queryable,
  input: { runId: string; instanceId: string; leaseMs: number },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE phis.job_runs
     SET locked_until = NOW() + ($3::int * INTERVAL '1 millisecond')
     WHERE id = $1::bigint AND instance_id = $2 AND finished_at IS NULL`,
    [input.runId, input.instanceId, input.leaseMs],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Closes a run and writes its outcome into the state row.
 *
 * Both in one transaction: a run that finished is also the job's last outcome, and the state row is
 * what survives once the run rows of a short step are pruned.
 */
export async function finishPhiJobRun(
  db: Pool,
  input: { run: PhiJobKey & { id: string; slotAt: string }; instanceId: string; error: string | null },
): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE phis.job_runs
       SET finished_at = NOW(),
           flags = flags | $3::int,
           error = $4
       WHERE id = $1::bigint AND instance_id = $2 AND finished_at IS NULL`,
      [input.run.id, input.instanceId, input.error === null ? PhiJobRunFlag.Succeeded : 0, input.error],
    );
    if ((rowCount ?? 0) === 0) {
      // Taken over meanwhile: the outcome is the other instance's to write.
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO phis.job_states (owner, job_id, site_id, last_slot_at, last_success_at, last_error, updated_at)
       VALUES ($1, $2, $3::smallint, $4::timestamptz, CASE WHEN $5::text IS NULL THEN NOW() END, $5, NOW())
       ON CONFLICT (owner, job_id, COALESCE(site_id, 0)) DO UPDATE
       SET last_slot_at = EXCLUDED.last_slot_at,
           last_success_at = COALESCE(EXCLUDED.last_success_at, phis.job_states.last_success_at),
           last_error = EXCLUDED.last_error,
           updated_at = NOW()`,
      [input.run.owner, input.run.jobId, input.run.siteId, input.run.slotAt, input.error],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Takes over runs whose runner went silent: unfinished, lease run out. Each row is moved to this
 * instance under a fresh lease in the same statement that selects it, so two instances taking over at
 * once divide the rows rather than both getting them.
 */
export async function takeOverPhiJobRuns(
  db: Queryable,
  input: { instanceId: string; leaseMs: number; limit?: number },
): Promise<PhiJobRunRecord[]> {
  const { rows } = await db.query<RunRow>(
    `UPDATE phis.job_runs
     SET instance_id = $1,
         locked_until = NOW() + ($2::int * INTERVAL '1 millisecond'),
         flags = flags | $3::int
     WHERE id IN (
       SELECT id FROM phis.job_runs
       WHERE finished_at IS NULL AND locked_until < NOW()
       ORDER BY locked_until ASC
       LIMIT $4::int
       FOR UPDATE SKIP LOCKED
     )
     RETURNING ${RUN_COLUMNS}`,
    [input.instanceId, input.leaseMs, PhiJobRunFlag.TakenOver, Math.max(1, Math.min(input.limit ?? 20, 200))],
  );
  return rows.map(mapRun);
}

/** The operator's switch. Creates the state row where no run has made one yet. */
export async function setPhiJobPaused(db: Queryable, key: PhiJobKey, paused: boolean): Promise<void> {
  await db.query(
    `INSERT INTO phis.job_states (owner, job_id, site_id, flags, updated_at)
     VALUES ($1, $2, $3::smallint, CASE WHEN $5::boolean THEN $4::int ELSE 0 END, NOW())
     ON CONFLICT (owner, job_id, COALESCE(site_id, 0)) DO UPDATE
     SET flags = CASE WHEN $5::boolean THEN phis.job_states.flags | $4::int ELSE phis.job_states.flags & ~$4::int END,
         updated_at = NOW()`,
    [key.owner, key.jobId, key.siteId, PhiJobStateFlag.Paused, paused],
  );
}

export async function listPhiJobStates(db: Queryable, filter: { owner?: string | null; siteId?: number | null } = {}) {
  const { rows } = await db.query<{
    owner: string;
    job_id: string;
    site_id: number | null;
    flags: number;
    last_slot_at: string | null;
    last_success_at: string | null;
    last_error: string | null;
  }>(
    `SELECT owner, job_id, site_id, flags, last_slot_at, last_success_at, last_error
     FROM phis.job_states
     WHERE ($1::text IS NULL OR owner = $1)
       AND ($2::smallint IS NULL OR site_id = $2)
     ORDER BY owner, job_id, site_id NULLS FIRST`,
    [filter.owner ?? null, filter.siteId ?? null],
  );
  return rows.map((row): PhiJobStateRecord => ({
    owner: row.owner,
    jobId: row.job_id,
    siteId: row.site_id,
    flags: row.flags,
    lastSlotAt: row.last_slot_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
  }));
}

/** The most recent runs, newest first, for the operator's `phis addon jobs`. */
export async function listPhiJobRuns(
  db: Queryable,
  filter: { owner?: string | null; jobId?: string | null; siteId?: number | null; limit?: number } = {},
): Promise<PhiJobRunRecord[]> {
  const { rows } = await db.query<RunRow>(
    `SELECT ${RUN_COLUMNS}
     FROM phis.job_runs
     WHERE ($1::text IS NULL OR owner = $1)
       AND ($2::text IS NULL OR job_id = $2)
       AND ($3::smallint IS NULL OR site_id = $3)
     ORDER BY id DESC
     LIMIT $4::int`,
    [filter.owner ?? null, filter.jobId ?? null, filter.siteId ?? null, Math.max(1, Math.min(filter.limit ?? 50, 500))],
  );
  return rows.map(mapRun);
}

/**
 * Drops finished runs past their retention. The short steps' successful runs go after `subHourlyMs`;
 * everything finished goes after `allMs`. `subHourlyOwnerJobs` names which (owner, job) pairs are the
 * short-stepped ones, since the ledger does not carry the step.
 */
export async function prunePhiJobRuns(
  db: Queryable,
  input: { subHourlyOwnerJobs: readonly { owner: string; jobId: string }[]; subHourlyMs: number; allMs: number },
): Promise<number> {
  const owners = input.subHourlyOwnerJobs.map((pair) => pair.owner);
  const jobIds = input.subHourlyOwnerJobs.map((pair) => pair.jobId);
  const { rowCount } = await db.query(
    `DELETE FROM phis.job_runs
     WHERE finished_at IS NOT NULL
       AND (
         finished_at < NOW() - ($3::bigint * INTERVAL '1 millisecond')
         OR (
           (flags & $4::int) <> 0
           AND finished_at < NOW() - ($5::bigint * INTERVAL '1 millisecond')
           AND (owner, job_id) IN (SELECT * FROM UNNEST($1::text[], $2::text[]))
         )
       )`,
    [owners, jobIds, input.allMs, PhiJobRunFlag.Succeeded, input.subHourlyMs],
  );
  return rowCount ?? 0;
}
