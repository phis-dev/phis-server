import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { PhiJobRunFlag, PhiJobStateFlag } from "../lib/constants/jobs.ts";
import {
  claimPhiJobSlot,
  finishPhiJobRun,
  listPhiJobRuns,
  listPhiJobStates,
  prunePhiJobRuns,
  renewPhiJobLease,
  setPhiJobPaused,
  takeOverPhiJobRuns,
} from "./job-runs.mts";

/**
 * The ledger's rules are the database's: one claim per moment, a lease that another instance may
 * take over once it ran out, a skipped moment while the previous run is going, and the operator's
 * switch. Each is a statement, so each is asserted against PostgreSQL rather than against a mock.
 */

const OWNER = "@pgtest/jobs";
let site: PhiTestSite;

beforeAll(async () => {
  await requirePhiTestDatabase();
  site = await createPhiTestSite("job-runs");
});

afterAll(async () => {
  const pool = await requirePhiTestDatabase();
  await pool.query(`DELETE FROM phis.job_runs WHERE owner = $1`, [OWNER]);
  await pool.query(`DELETE FROM phis.job_states WHERE owner = $1`, [OWNER]);
  await dropPhiTestSites();
  await closePhiTestPool();
});

describe("claiming a moment", () => {
  it("admits the first instance and tells the second it is taken", async () => {
    const pool = await requirePhiTestDatabase();
    const slotAt = new Date("2026-11-09T09:15:00.000Z");
    const key = { owner: OWNER, jobId: "claim", siteId: site.id };
    const first = await claimPhiJobSlot(pool, { ...key, slotAt, instanceId: "a", leaseMs: 60_000 });
    const second = await claimPhiJobSlot(pool, { ...key, slotAt, instanceId: "b", leaseMs: 60_000 });
    expect(first.outcome).toBe("claimed");
    expect(second.outcome).toBe("taken");
    if (first.outcome !== "claimed") throw new Error("unreachable");
    expect(first.run.instanceId).toBe("a");
    expect(first.run.finishedAt).toBeNull();

    expect(await finishPhiJobRun(pool, { run: { ...key, id: first.run.id, slotAt: first.run.slotAt }, instanceId: "b", error: null })).toBe(false);
    expect(await finishPhiJobRun(pool, { run: { ...key, id: first.run.id, slotAt: first.run.slotAt }, instanceId: "a", error: null })).toBe(true);
    const [state] = await listPhiJobStates(pool, { owner: OWNER, siteId: site.id });
    expect(state?.lastSuccessAt).not.toBeNull();
    const [run] = await listPhiJobRuns(pool, { owner: OWNER, jobId: "claim" });
    expect(run?.flags).toBe(PhiJobRunFlag.Succeeded);
  });

  it("records the next moment as skipped while the previous run still holds its lease", async () => {
    const pool = await requirePhiTestDatabase();
    const key = { owner: OWNER, jobId: "slow", siteId: null };
    const first = await claimPhiJobSlot(pool, { ...key, slotAt: new Date("2026-11-09T09:00:00.000Z"), instanceId: "a", leaseMs: 60_000 });
    expect(first.outcome).toBe("claimed");
    const next = await claimPhiJobSlot(pool, { ...key, slotAt: new Date("2026-11-09T09:05:00.000Z"), instanceId: "b", leaseMs: 60_000 });
    expect(next.outcome).toBe("skipped");
    if (next.outcome !== "skipped") throw new Error("unreachable");
    expect(next.run.finishedAt).not.toBeNull();
    expect(next.run.flags & PhiJobRunFlag.Skipped).toBe(PhiJobRunFlag.Skipped);
    // Asked again for the same moment, it is simply taken: the skip is recorded once.
    const again = await claimPhiJobSlot(pool, { ...key, slotAt: new Date("2026-11-09T09:05:00.000Z"), instanceId: "b", leaseMs: 60_000 });
    expect(again.outcome).toBe("taken");
  });

  it("passes a paused job by, and runs it again once resumed", async () => {
    const pool = await requirePhiTestDatabase();
    const key = { owner: OWNER, jobId: "paused", siteId: site.id };
    await setPhiJobPaused(pool, key, true);
    expect((await listPhiJobStates(pool, { owner: OWNER }))
      .find((state) => state.jobId === "paused")?.flags).toBe(PhiJobStateFlag.Paused);
    const paused = await claimPhiJobSlot(pool, { ...key, slotAt: new Date("2026-11-09T10:00:00.000Z"), instanceId: "a", leaseMs: 60_000 });
    expect(paused.outcome).toBe("taken");
    await setPhiJobPaused(pool, key, false);
    const resumed = await claimPhiJobSlot(pool, { ...key, slotAt: new Date("2026-11-09T10:00:00.000Z"), instanceId: "a", leaseMs: 60_000 });
    expect(resumed.outcome).toBe("claimed");
  });
});

describe("a lease", () => {
  it("is renewed by its holder only, and taken over once it ran out", async () => {
    const pool = await requirePhiTestDatabase();
    const key = { owner: OWNER, jobId: "lease", siteId: null };
    const claim = await claimPhiJobSlot(pool, { ...key, slotAt: new Date("2026-11-09T11:00:00.000Z"), instanceId: "a", leaseMs: 1 });
    if (claim.outcome !== "claimed") throw new Error("unreachable");
    expect(await renewPhiJobLease(pool, { runId: claim.run.id, instanceId: "b", leaseMs: 60_000 })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const taken = await takeOverPhiJobRuns(pool, { instanceId: "b", leaseMs: 60_000 });
    const mine = taken.find((run) => run.id === claim.run.id);
    expect(mine?.instanceId).toBe("b");
    expect((mine?.flags ?? 0) & PhiJobRunFlag.TakenOver).toBe(PhiJobRunFlag.TakenOver);
    // The old holder's renewal and finish now find nothing of theirs.
    expect(await renewPhiJobLease(pool, { runId: claim.run.id, instanceId: "a", leaseMs: 60_000 })).toBe(false);
    expect(await finishPhiJobRun(pool, { run: { ...key, id: claim.run.id, slotAt: claim.run.slotAt }, instanceId: "a", error: null })).toBe(false);
    expect(await finishPhiJobRun(pool, { run: { ...key, id: claim.run.id, slotAt: claim.run.slotAt }, instanceId: "b", error: "gave up" })).toBe(true);
    const [state] = (await listPhiJobStates(pool, { owner: OWNER })).filter((row) => row.jobId === "lease");
    expect(state?.lastError).toBe("gave up");
    expect(state?.lastSuccessAt).toBeNull();
  });
});

describe("retention", () => {
  it("drops a short step's old successes after a day and everything after thirty, keeping the state", async () => {
    const pool = await requirePhiTestDatabase();
    const key = { owner: OWNER, jobId: "prune", siteId: null };
    for (const [slot, age, error] of [
      ["2026-10-01T00:00:00.000Z", "40 days", null],
      ["2026-10-20T00:00:00.000Z", "2 days", null],
      ["2026-10-21T00:00:00.000Z", "2 days", "failed"],
      ["2026-10-22T00:00:00.000Z", "1 hour", null],
    ] as const) {
      const claim = await claimPhiJobSlot(pool, { ...key, slotAt: new Date(slot), instanceId: "a", leaseMs: 60_000 });
      if (claim.outcome !== "claimed") throw new Error("unreachable");
      await finishPhiJobRun(pool, { run: { ...key, id: claim.run.id, slotAt: claim.run.slotAt }, instanceId: "a", error });
      await pool.query(`UPDATE phis.job_runs SET finished_at = NOW() - $2::interval WHERE id = $1::bigint`, [claim.run.id, age]);
    }
    const dropped = await prunePhiJobRuns(pool, {
      subHourlyOwnerJobs: [{ owner: OWNER, jobId: "prune" }],
      subHourlyMs: 24 * 60 * 60_000,
      allMs: 30 * 24 * 60 * 60_000,
    });
    expect(dropped).toBe(2);
    const left = await listPhiJobRuns(pool, { owner: OWNER, jobId: "prune" });
    expect(left.map((run) => run.error)).toEqual([null, "failed"]);
    expect((await listPhiJobStates(pool, { owner: OWNER })).some((state) => state.jobId === "prune")).toBe(true);
  });
});
