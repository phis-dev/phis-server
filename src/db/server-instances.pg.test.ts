import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  listPhisServerInstances,
  markPhisServerInstanceStopped,
  prunePhisServerInstances,
  recordPhisServerInstance,
  type PhisServerInstanceReport,
} from "./server-instances.mts";
import { closePhiTestPool, requirePhiTestDatabase } from "../../test/pg/harness";

/**
 * The self-report end to end.
 *
 * What has to hold is less about the write than about what a reader may conclude from it: readiness is
 * a bit and a timestamp together, a restart is not a second row, and a drained instance stays visible
 * after it stops answering.
 */

const INSTANCE_ID = "pgtest-web:/srv/phis/stages/pgtest";
const OTHER_ID = "pgtest-web-2:/srv/phis/stages/pgtest";

function reportWith(overrides: Partial<PhisServerInstanceReport> = {}): PhisServerInstanceReport {
  return {
    instanceId: INSTANCE_ID,
    releaseBuildId: "0.1.0",
    addonManifestDigest: "a".repeat(64),
    addonPackages: { "@pgtest/status": "1.0.0" },
    capabilityDigests: { "@phis/server/data:v1": "b".repeat(64) },
    ready: true,
    ...overrides,
  };
}

async function readOne(instanceId: string) {
  const instances = await listPhisServerInstances(await requirePhiTestDatabase(), 90);
  return instances.find((instance) => instance.instanceId === instanceId) ?? null;
}

async function cleanUp() {
  const pool = await requirePhiTestDatabase();
  await pool.query(`DELETE FROM phis.server_instances WHERE instance_id LIKE 'pgtest-%'`);
}

describe("instance heartbeat", () => {
  beforeAll(async () => {
    await requirePhiTestDatabase();
    await cleanUp();
  });

  afterAll(async () => {
    await cleanUp();
    await closePhiTestPool();
  });

  it("records what an instance holds, and reads it back unchanged", async () => {
    const pool = await requirePhiTestDatabase();
    await recordPhisServerInstance(pool, reportWith());

    const stored = await readOne(INSTANCE_ID);
    expect(stored).not.toBeNull();
    expect(stored?.releaseBuildId).toBe("0.1.0");
    expect(stored?.addonPackages).toEqual({ "@pgtest/status": "1.0.0" });
    expect(stored?.capabilityDigests).toEqual({ "@phis/server/data:v1": "b".repeat(64) });
    expect(stored?.ready).toBe(true);
  });

  it("moves started_at on a restart instead of leaving a second row behind", async () => {
    const pool = await requirePhiTestDatabase();
    const first = await readOne(INSTANCE_ID);
    await recordPhisServerInstance(pool, reportWith({ releaseBuildId: "0.2.0" }));

    const instances = await listPhisServerInstances(pool, 90);
    const mine = instances.filter((instance) => instance.instanceId === INSTANCE_ID);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.releaseBuildId).toBe("0.2.0");
    expect(new Date(mine[0]!.startedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first!.startedAt).getTime(),
    );
  });

  it("keeps a drained instance visible but no longer ready", async () => {
    const pool = await requirePhiTestDatabase();
    await markPhisServerInstanceStopped(pool, INSTANCE_ID);

    const stored = await readOne(INSTANCE_ID);
    expect(stored).not.toBeNull();
    expect(stored?.ready).toBe(false);
  });

  it("is not ready once the heartbeat is older than the reader's window", async () => {
    const pool = await requirePhiTestDatabase();
    await recordPhisServerInstance(pool, reportWith({ instanceId: OTHER_ID }));
    await pool.query(
      `UPDATE phis.server_instances
          SET last_seen_at = NOW() - INTERVAL '10 minutes'
        WHERE instance_id = $1`,
      [OTHER_ID],
    );

    const fresh = await listPhisServerInstances(pool, 90);
    expect(fresh.find((instance) => instance.instanceId === OTHER_ID)?.ready).toBe(false);

    // The bit itself never changed; only what the reader was willing to believe about it.
    const patient = await listPhisServerInstances(pool, 60 * 60);
    expect(patient.find((instance) => instance.instanceId === OTHER_ID)?.ready).toBe(true);
  });

  it("forgets an instance that has been silent far longer than it has been unready", async () => {
    const pool = await requirePhiTestDatabase();
    expect(await prunePhisServerInstances(pool, 60 * 60)).toBe(0);
    expect(await prunePhisServerInstances(pool, 60)).toBeGreaterThan(0);
    expect(await readOne(OTHER_ID)).toBeNull();
  });
});
