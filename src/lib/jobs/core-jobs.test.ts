import { describe, expect, it } from "vitest";

import { PHIS_ADDON_JOB_INTERVALS } from "@phis/contracts/addon";

import { PHI_MAINTENANCE_TASKS } from "../../cli/maintain.mts";
import { PHI_CORE_JOBS, findPhiCoreJob } from "./core-jobs";
import { PHI_JOB_TIME_PATTERN, resolvePhiJobSlot } from "./slots";

/** The housekeeping that used to need an operator's timer: the maintain task and the Core job that took it over. */
const MAINTENANCE_JOBS: Record<string, { jobId: string; every: string; at?: string }> = {
  "queue-retention": { jobId: "queues.prune", every: "daily", at: "02:10" },
  "hook-deliveries": { jobId: "hook-deliveries.prune", every: "daily", at: "02:25" },
  "upload-sessions": { jobId: "upload-sessions.prune", every: "hourly" },
  "addon-assets": { jobId: "addon-assets.collect", every: "daily", at: "02:40" },
  "support-requester-window": { jobId: "support-tickets.close", every: "daily", at: "02:55" },
  payments: { jobId: "payments.recover", every: "hourly" },
};

describe("Core's own jobs", () => {
  it("has each job once, under an id and with a summary", () => {
    const ids = PHI_CORE_JOBS.map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const job of PHI_CORE_JOBS) {
      expect(job.id).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/u);
      expect(job.summary.length).toBeGreaterThan(0);
      expect(findPhiCoreJob(job.id)).toBe(job);
    }
  });

  it("names a valid schedule for every job", () => {
    const now = new Date("2026-11-17T12:00:00.000Z");
    for (const job of PHI_CORE_JOBS) {
      expect(PHIS_ADDON_JOB_INTERVALS).toContain(job.schedule.every);
      if (job.schedule.every === "daily" || job.schedule.every === "weekly") {
        expect(job.schedule.at ?? "00:00").toMatch(PHI_JOB_TIME_PATTERN);
      } else {
        expect(job.schedule.at).toBeUndefined();
      }
      expect(Number.isNaN(resolvePhiJobSlot(job.schedule, now).getTime())).toBe(false);
    }
  });

  it("runs every housekeeping task of `phis maintain` on the clock, except the full store listing", () => {
    for (const task of PHI_MAINTENANCE_TASKS) {
      const expected = MAINTENANCE_JOBS[task.id];
      if (task.id === "addon-storage") {
        expect(expected).toBeUndefined();
        continue;
      }
      expect(expected, `${task.id} has a job`).toBeDefined();
      expect(findPhiCoreJob(expected!.jobId)?.schedule).toEqual(
        expected!.at ? { every: expected!.every, at: expected!.at } : { every: expected!.every },
      );
    }
    expect(PHI_CORE_JOBS.some((job) => job.id.startsWith("addon-storage"))).toBe(false);
  });

  it("staggers the nightly jobs, in UTC, away from the ledger's own pruning", () => {
    const nightly = PHI_CORE_JOBS.filter((job) => job.schedule.every === "daily").map((job) => job.schedule.at);
    expect(new Set(nightly).size).toBe(nightly.length);
    for (const at of nightly) {
      const [hours] = at!.split(":").map(Number);
      expect(hours).toBeGreaterThanOrEqual(1);
      expect(hours).toBeLessThanOrEqual(5);
    }
  });
});
