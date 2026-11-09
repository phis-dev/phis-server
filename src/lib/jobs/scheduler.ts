import "server-only";

import type { PhisAddonJobSchedule } from "@phis/contracts/addon";

import { PhisAddonJobError, runPhisAddonJob } from "@/lib/addons/jobs";
import { getPhisAddonInstalledManifest } from "@/lib/addons/installed";
import { getDefaultServerPhiRoot } from "@/lib/config-files";
import {
  PHI_CORE_JOB_OWNER,
  PHI_JOB_LEASE_MS,
  PHI_JOB_LEASE_RENEWAL_MS,
  PHI_JOB_TICK_MS,
} from "@/lib/constants/jobs";
import { getPool } from "@/lib/db";
import { resolvePhisInstanceId } from "@/lib/instance-identity.mts";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import {
  claimPhiJobSlot,
  finishPhiJobRun,
  renewPhiJobLease,
  takeOverPhiJobRuns,
  type PhiJobKey,
  type PhiJobRunRecord,
} from "@/db/job-runs.mts";
import { readPhisAddonReadySiteIds } from "@/db/server-addon-sites.mts";
import { getSiteIdentityById } from "@/db/sites";
import { findPhiCoreJob, PHI_CORE_JOBS } from "./core-jobs";
import { resolvePhiJobSlot } from "./slots";

/**
 * The clock of this installation (SERVER_ADDONS.md, Jobs).
 *
 * Every instance of Core runs this ticker, and none of them is the leader. Each minute an instance
 * computes, for every scheduled job, the latest moment the schedule names, and asks the database for
 * that moment; the moment is a row with a unique key, so exactly one instance is told yes and runs the
 * job, and the others are told that it is taken. What used to be an operator's timer per job and per
 * Site is therefore one timer nobody installs.
 *
 * A running job holds a lease on its row and renews it while it works. A lease that ran out with the
 * row unfinished belonged to an instance that died, and the next tick of any instance takes the row
 * over and runs the job again -- which is why a job must be repeatable. A job still going when its
 * next moment comes has that moment recorded as skipped, never run beside itself.
 *
 * A tick claims one moment after another and lets the runs go side by side. Run one after another, a
 * slow job of one Add-on held up the outbox drain and the notifications of everybody else for as long
 * as it renewed its lease; what keeps a job from running beside itself is its row, not the tick.
 */

type JobWork = (signal: AbortSignal) => Promise<void>;

let timer: NodeJS.Timeout | null = null;
let ticking = false;
/** The runs this instance has going, so that a tick never waits for one and nothing is lost track of. */
const runs = new Set<Promise<unknown>>();

function launch(run: PhiJobRunRecord, work: JobWork | null) {
  const pending: Promise<unknown> = execute(run, work)
    .catch(() => undefined)
    .finally(() => {
      runs.delete(pending);
    });
  runs.add(pending);
}

function instanceId(): string {
  return resolvePhisInstanceId(getDefaultServerPhiRoot());
}

async function runAddonJob(addonId: string, jobId: string, siteId: number | null, signal: AbortSignal) {
  if (siteId === null) {
    throw new PhisAddonJobError("An Add-on job runs for one Site.");
  }
  const site = await getSiteIdentityById(siteId);
  if (!site) {
    throw new PhisAddonJobError(`Site ${siteId} does not exist.`);
  }
  const outcome = await runPhisAddonJob({ addonId, jobId, site, signal });
  if (!outcome.ok) {
    throw new Error(outcome.error ?? "The job failed.");
  }
}

/**
 * What a (owner, job) names, or null where nothing declares it any more: an Add-on removed since the
 * moment was claimed, a job its new release no longer has.
 */
function resolveWork(key: PhiJobKey): JobWork | null {
  if (key.owner === PHI_CORE_JOB_OWNER) {
    const job = findPhiCoreJob(key.jobId);
    return job ? (signal) => job.run(signal) : null;
  }
  const entry = getPhisAddonInstalledManifest()[key.owner];
  if (!entry || !entry.enabled || !entry.manifest.jobs.some((job) => job.id === key.jobId)) {
    return null;
  }
  return (signal) => runAddonJob(key.owner, key.jobId, key.siteId, signal);
}

/**
 * Runs one claimed moment under its lease, and writes the outcome.
 *
 * The lease is renewed on a timer while the work runs; a renewal that finds the row no longer this
 * instance's -- taken over because a renewal was late -- aborts the work through the signal, and the
 * outcome is then the other instance's to write.
 */
async function execute(run: PhiJobRunRecord, work: JobWork | null): Promise<{ ok: boolean; error: string | null }> {
  const me = instanceId();
  const controller = new AbortController();
  const renewal = setInterval(() => {
    void renewPhiJobLease(getPool(), { runId: run.id, instanceId: me, leaseMs: PHI_JOB_LEASE_MS })
      .then((kept) => {
        if (!kept) controller.abort();
      })
      .catch(() => undefined);
  }, PHI_JOB_LEASE_RENEWAL_MS);
  renewal.unref();

  let error: string | null = null;
  try {
    if (!work) {
      throw new Error(`${run.owner} no longer declares the job ${run.jobId}.`);
    }
    await work(controller.signal);
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    clearInterval(renewal);
  }

  const written = await finishPhiJobRun(getPool(), {
    run: { owner: run.owner, jobId: run.jobId, siteId: run.siteId, id: run.id, slotAt: run.slotAt },
    instanceId: me,
    error,
  });
  logRuntimeEvent(error ? "error" : "info", error ? "job.failed" : "job.ran", {
    message: error ?? undefined,
    pluginKey: run.owner,
    meta: { jobId: run.jobId, siteId: run.siteId, runId: run.id, slotAt: run.slotAt, recorded: written },
  });
  return { ok: error === null, error };
}

async function attempt(key: PhiJobKey, schedule: PhisAddonJobSchedule, now: Date, work: JobWork) {
  const claim = await claimPhiJobSlot(getPool(), {
    ...key,
    slotAt: resolvePhiJobSlot(schedule, now),
    instanceId: instanceId(),
    leaseMs: PHI_JOB_LEASE_MS,
  });
  if (claim.outcome === "claimed") {
    launch(claim.run, work);
  } else if (claim.outcome === "skipped") {
    logRuntimeEvent("warn", "job.skipped", {
      message: "The previous moment's run was still going.",
      pluginKey: key.owner,
      meta: { jobId: key.jobId, siteId: key.siteId, slotAt: claim.run.slotAt },
    });
  }
}

async function tick() {
  if (ticking) {
    return;
  }
  ticking = true;
  try {
    const now = new Date();
    for (const run of await takeOverPhiJobRuns(getPool(), { instanceId: instanceId(), leaseMs: PHI_JOB_LEASE_MS })) {
      launch(run, resolveWork({ owner: run.owner, jobId: run.jobId, siteId: run.siteId }));
    }
    for (const job of PHI_CORE_JOBS) {
      await attempt({ owner: PHI_CORE_JOB_OWNER, jobId: job.id, siteId: null }, job.schedule, now, (signal) => job.run(signal));
    }
    for (const [addonId, entry] of Object.entries(getPhisAddonInstalledManifest())) {
      if (!entry.enabled) continue;
      const scheduled = entry.manifest.jobs.filter((job) => job.schedule);
      if (scheduled.length === 0) continue;
      const siteIds = await readPhisAddonReadySiteIds(getPool(), addonId);
      for (const job of scheduled) {
        for (const siteId of siteIds) {
          await attempt(
            { owner: addonId, jobId: job.id, siteId },
            job.schedule!,
            now,
            (signal) => runAddonJob(addonId, job.id, siteId, signal),
          );
        }
      }
    }
  } catch (error) {
    // A tick that cannot reach the database claims nothing and runs nothing; the next one tries again.
    logRuntimeEvent("error", "job.tick_failed", { error: normalizeLogThrowable(error) });
  } finally {
    // The claims are done; the runs they started go on under their own leases.
    ticking = false;
  }
}

/**
 * Starts the clock on this instance.
 *
 * The first tick waits a few random seconds so that instances started together do not all ask the
 * database at the same moment; after that, once a minute. Unreferenced, like the heartbeat, so the
 * timer never holds the process open by itself.
 */
export function startPhiJobScheduler() {
  if (timer) {
    return;
  }
  timer = setTimeout(() => {
    void tick();
    timer = setInterval(() => {
      void tick();
    }, PHI_JOB_TICK_MS);
    timer.unref();
  }, Math.floor(Math.random() * 20_000));
  timer.unref();
}

/**
 * Runs one job now, for an operator (`phis addon job`), through the same ledger as the clock.
 *
 * A manual run claims a moment of its own, so it shows in the ledger like any other and cannot run
 * beside the scheduled run of the same job -- if one is going, the manual moment is recorded as
 * skipped and refused. Refusals of the job itself -- not installed, not declared -- are the caller's
 * mistake and are thrown as `PhisAddonJobError`, as the job runner throws them.
 */
export async function runPhiJobNow(key: PhiJobKey): Promise<{ runId: string; ok: boolean; error: string | null }> {
  const work = resolveWork(key);
  if (!work) {
    throw new PhisAddonJobError(`${key.owner} declares no job named ${key.jobId}, or is not enabled.`);
  }
  if (key.owner === PHI_CORE_JOB_OWNER && key.siteId !== null) {
    throw new PhisAddonJobError("A Core job runs for the stage, not for a Site.");
  }
  const claim = await claimPhiJobSlot(getPool(), {
    ...key,
    slotAt: new Date(),
    instanceId: instanceId(),
    leaseMs: PHI_JOB_LEASE_MS,
    manual: true,
  });
  if (claim.outcome === "taken") {
    throw new PhisAddonJobError("This job is paused.");
  }
  if (claim.outcome === "skipped") {
    return { runId: claim.run.id, ok: false, error: "A run of this job is still going." };
  }
  const outcome = await execute(claim.run, work);
  return { runId: claim.run.id, ...outcome };
}
