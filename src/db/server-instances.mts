import type { Pool } from "pg";

import { PHIS_INSTANCE_FLAG_READY } from "../lib/constants/server-addons.ts";

/**
 * What one serving instance reports about itself.
 *
 * Section 17 of `SERVER_ADDONS.md`: a shared Add-on row does not prove that every serving instance
 * carries the same code, so each one says what it actually holds. The row is a self-report, never a
 * poll -- nothing here reaches out to a host, which is what keeps a fleet from needing an orchestrator
 * holding credentials to every machine.
 */
export type PhisServerInstanceReport = {
  instanceId: string;
  releaseBuildId: string;
  addonManifestDigest: string;
  /** Add-on id to installed package version, as this instance has it on disk. */
  addonPackages: Record<string, string>;
  /** Capability id to interface digest, for Core and every locally installed Add-on. */
  capabilityDigests: Record<string, string>;
  ready: boolean;
};

export type PhisServerInstanceRecord = PhisServerInstanceReport & {
  lastSeenAt: string;
  startedAt: string;
};

/**
 * Records this instance, or refreshes what it already said.
 *
 * `started_at` survives the conflict and `last_seen_at` does not: together they say how long this
 * process has been up and whether it is still there. A restart under the same id is therefore visible
 * as a moved `started_at` rather than as a second row nobody cleans up.
 */
export async function recordPhisServerInstance(pool: Pool, report: PhisServerInstanceReport) {
  await pool.query(
    `INSERT INTO phis.server_instances (
       instance_id,
       release_build_id,
       addon_manifest_digest,
       addon_packages_json,
       capability_digests_json,
       flags,
       last_seen_at,
       started_at
     )
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::int, NOW(), NOW())
     ON CONFLICT (instance_id) DO UPDATE
     SET release_build_id = EXCLUDED.release_build_id,
         addon_manifest_digest = EXCLUDED.addon_manifest_digest,
         addon_packages_json = EXCLUDED.addon_packages_json,
         capability_digests_json = EXCLUDED.capability_digests_json,
         flags = EXCLUDED.flags,
         last_seen_at = NOW()`,
    [
      report.instanceId,
      report.releaseBuildId,
      report.addonManifestDigest,
      JSON.stringify(report.addonPackages),
      JSON.stringify(report.capabilityDigests),
      report.ready ? PHIS_INSTANCE_FLAG_READY : 0,
    ],
  );
}

/**
 * Withdraws readiness without deleting the row.
 *
 * A draining instance should stop receiving traffic before its heartbeat goes stale, and an operator
 * looking afterwards should still see that it was here and when it left. Deleting the row would answer
 * the first question and lose the second.
 */
export async function markPhisServerInstanceStopped(pool: Pool, instanceId: string) {
  await pool.query(
    `UPDATE phis.server_instances
        SET flags = flags & ~($1::int),
            last_seen_at = NOW()
      WHERE instance_id = $2`,
    [PHIS_INSTANCE_FLAG_READY, instanceId],
  );
}

/**
 * Every instance that has reported, newest heartbeat first.
 *
 * `staleAfterSeconds` decides what ready means to the reader rather than to the writer. An instance
 * killed rather than drained keeps its ready bit set and only its heartbeat betrays it, so a caller
 * trusting the bit alone would route traffic to a process that is gone.
 */
export async function listPhisServerInstances(pool: Pool, staleAfterSeconds: number) {
  const { rows } = await pool.query<{
    instance_id: string;
    release_build_id: string;
    addon_manifest_digest: string;
    addon_packages_json: Record<string, string>;
    capability_digests_json: Record<string, string>;
    ready: boolean;
    last_seen_at: string;
    started_at: string;
  }>(
    `SELECT instance_id,
            release_build_id,
            addon_manifest_digest,
            addon_packages_json,
            capability_digests_json,
            ((flags & $1::int) <> 0
              AND last_seen_at > NOW() - MAKE_INTERVAL(secs => $2::float8)) AS ready,
            last_seen_at,
            started_at
       FROM phis.server_instances
      ORDER BY last_seen_at DESC`,
    [PHIS_INSTANCE_FLAG_READY, staleAfterSeconds],
  );

  return rows.map<PhisServerInstanceRecord>((row) => ({
    instanceId: row.instance_id,
    releaseBuildId: row.release_build_id,
    addonManifestDigest: row.addon_manifest_digest,
    addonPackages: row.addon_packages_json,
    capabilityDigests: row.capability_digests_json,
    ready: row.ready,
    lastSeenAt: row.last_seen_at,
    startedAt: row.started_at,
  }));
}

/**
 * Drops instances nobody has heard from in a long time.
 *
 * A decommissioned host never says so, and a table that only grows stops being readable. The window is
 * deliberately far longer than the staleness one: not being ready is a fact about right now, having
 * ceased to exist is a claim that should have days of silence behind it.
 */
export async function prunePhisServerInstances(pool: Pool, forgetAfterSeconds: number) {
  const { rowCount } = await pool.query(
    `DELETE FROM phis.server_instances
      WHERE last_seen_at < NOW() - MAKE_INTERVAL(secs => $1::float8)`,
    [forgetAfterSeconds],
  );
  return rowCount ?? 0;
}
