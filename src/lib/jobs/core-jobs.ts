import "server-only";

import type { PhisAddonJobSchedule } from "@phis/contracts/addon";

import { getPhisAddonInstalledManifest } from "@/lib/addons/installed";
import { drainPhisAddonEventsForSite } from "@/lib/addons/event-delivery";
import { listPhisAddonEventSiteIds } from "@/db/addon-events";
import { prunePhiJobRuns } from "@/db/job-runs.mts";
import { deleteExpiredAuthTransactions } from "@/db/site-auth";
import { deleteExpiredUserSessions } from "@/db/user-sessions";
import {
  PHI_CORE_JOB_OWNER,
  PHI_JOB_RUN_RETENTION_MS,
  PHI_JOB_RUN_RETENTION_SUB_HOURLY_MS,
} from "@/lib/constants/jobs";
import { getPool } from "@/lib/db";
import { drainPhiNotifications } from "@/lib/notifications/deliver";
import { runDuePhisPaymentSubscriptions } from "@/lib/payments/runtime";
import { isPhiJobStepSubHourly } from "./slots";

/**
 * Core's own jobs: the work this server owes on a clock, scheduled exactly as an Add-on's jobs are.
 *
 * Before the scheduler, each of these was an operator's timer calling the CLI, and an installation
 * without the timer sent no mail twice and delivered no event twice. They run for the stage, not for a
 * Site, because each walks every Site that owes something. The two drains are the retry: the request
 * that wrote a row already tried once, so five minutes is how late a retry is at most.
 */
export type PhiCoreJob = {
  id: string;
  schedule: PhisAddonJobSchedule;
  summary: string;
  run: (signal: AbortSignal) => Promise<void>;
};

/** The (owner, job) pairs whose step is shorter than an hour, whose successful runs are kept a day. */
function listSubHourlyJobs(): { owner: string; jobId: string }[] {
  const pairs: { owner: string; jobId: string }[] = [];
  for (const job of PHI_CORE_JOBS) {
    if (isPhiJobStepSubHourly(job.schedule.every)) pairs.push({ owner: PHI_CORE_JOB_OWNER, jobId: job.id });
  }
  for (const [addonId, entry] of Object.entries(getPhisAddonInstalledManifest())) {
    for (const job of entry.manifest.jobs) {
      if (job.schedule && isPhiJobStepSubHourly(job.schedule.every)) pairs.push({ owner: addonId, jobId: job.id });
    }
  }
  return pairs;
}

export const PHI_CORE_JOBS: readonly PhiCoreJob[] = Object.freeze([
  {
    id: "addon-events.deliver",
    schedule: { every: "5m" },
    summary: "Delivers what the Add-on event outbox still owes, on every Site that owes something.",
    async run(signal: AbortSignal) {
      for (const siteId of await listPhisAddonEventSiteIds()) {
        if (signal.aborted) return;
        await drainPhisAddonEventsForSite(siteId);
      }
    },
  },
  {
    id: "payments.subscriptions.advance",
    schedule: { every: "5m" },
    summary: "Charges the subscription periods that fell due, retries the ones that failed, and ends what was cancelled.",
    async run(signal: AbortSignal) {
      /*
       * Bounded per run, and run again in five minutes: a long list is worked off over several runs
       * instead of holding one for as long as every Provider takes to answer.
       */
      await runDuePhisPaymentSubscriptions(100, signal);
    },
  },
  {
    id: "notifications.deliver",
    schedule: { every: "5m" },
    summary: "Sends what the notification outbox still owes.",
    async run() {
      await drainPhiNotifications(500);
    },
  },
  {
    id: "auth.prune",
    schedule: { every: "hourly" },
    summary: "Drops expired sessions and finished sign-in transactions.",
    async run() {
      /*
       * This used to run inside every sign-in and every provider start, a housekeeping delete on the
       * request path of the person signing in. It is the clock's work.
       */
      await deleteExpiredUserSessions();
      await deleteExpiredAuthTransactions();
    },
  },
  {
    id: "job-runs.prune",
    schedule: { every: "daily", at: "03:30" },
    summary: "Drops finished job runs past their retention; the state rows keep each job's last outcome.",
    async run() {
      await prunePhiJobRuns(getPool(), {
        subHourlyOwnerJobs: listSubHourlyJobs(),
        subHourlyMs: PHI_JOB_RUN_RETENTION_SUB_HOURLY_MS,
        allMs: PHI_JOB_RUN_RETENTION_MS,
      });
    },
  },
]);

export function findPhiCoreJob(jobId: string): PhiCoreJob | null {
  return PHI_CORE_JOBS.find((job) => job.id === jobId) ?? null;
}
