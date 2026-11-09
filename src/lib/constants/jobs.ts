/**
 * The scheduler's vocabulary (SERVER_ADDONS.md, Jobs; DB.md, `phis.job_runs` and `phis.job_states`).
 *
 * Core's own jobs are owned by `@phis/server`, the one id no Add-on can carry; a job's full name is
 * `owner` plus `job_id`, which is how `phis addon job` and the ledger address it.
 */
export const PHI_CORE_JOB_OWNER = "@phis/server";

/** Bits of `phis.job_runs.flags`. */
export const PhiJobRunFlag = {
  /** The run finished without an error. */
  Succeeded: 1,
  /** Another instance took the run over after the runner's lease ran out. */
  TakenOver: 2,
  /** The moment was recorded but not run, because the previous moment's run was still going. */
  Skipped: 4,
  /** An operator started this run, not the clock. */
  Manual: 8,
} as const;

/** Bits of `phis.job_states.flags`. */
export const PhiJobStateFlag = {
  /** The operator switched this job off; the clock passes it by until it is resumed. */
  Paused: 1,
} as const;

/** How often an instance looks at the clock. Every step is a multiple of this. */
export const PHI_JOB_TICK_MS = 60_000;

/** How long a runner's claim holds before another instance may assume it died mid-run. */
export const PHI_JOB_LEASE_MS = 2 * 60_000;

/** How often a runner renews its lease while the job is still going. */
export const PHI_JOB_LEASE_RENEWAL_MS = 30_000;

/**
 * How long a finished run stays in the ledger: a day for the successful runs of a step shorter than an
 * hour, which would otherwise be hundreds of rows a day per job and Site, and thirty days for all else.
 * `phis.job_states` keeps the last outcome of every job past both.
 */
export const PHI_JOB_RUN_RETENTION_SUB_HOURLY_MS = 24 * 60 * 60_000;
export const PHI_JOB_RUN_RETENTION_MS = 30 * 24 * 60 * 60_000;
