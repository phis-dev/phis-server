import type { Pool } from "pg";

import { PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID } from "@phis/contracts/addon";

import { listPhisServerInstances, type PhisServerInstanceRecord } from "../db/server-instances.mts";

/*
 * Whether every serving Instance could open a Storage Profile of one Provider.
 *
 * Shared by the CLI (`phis storage use|enable`) and the Admin Media storage settings, which both put a
 * Provider on the write path. Relative imports only, so the CLI bundle can carry it.
 */

/** How long an Instance's heartbeat counts as current here: three of its 30-second beats. */
const PHIS_STORAGE_READINESS_STALE_AFTER_SECONDS = 90;

/**
 * The serving Instances that could not open a Profile of this Provider.
 *
 * An Instance serves when its heartbeat is current and it reports itself ready, which already includes
 * being able to read the secret store -- so a ready Instance can resolve the Profile's secret, and what is
 * left to ask is whether it holds the Provider's Add-on. A provider key begins with its Add-on's id and a
 * slash (the manifest validator holds every Add-on to that), so the Instance's own package list answers it.
 * Stale and draining Instances are not asked: they serve nothing.
 */
export function findPhisInstancesLackingProvider(
  instances: readonly PhisServerInstanceRecord[],
  providerId: string,
): { serving: number; lacking: string[] } {
  const serving = instances.filter((instance) => instance.ready);
  if (providerId === PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID) {
    return { serving: serving.length, lacking: [] };
  }
  const lacking = serving
    .filter((instance) => !Object.keys(instance.addonPackages).some((addonId) => providerId.startsWith(`${addonId}/`)))
    .map((instance) => instance.instanceId);
  return { serving: serving.length, lacking };
}

/**
 * Refuses to point new uploads at a Provider that some serving Instance cannot open.
 *
 * Every request that landed on such an Instance would be refused, so activating the Profile would break a
 * share of uploads and deliveries that depends on the load balancer. With no serving Instance at all --
 * the CLI run while the Server is down -- there is nothing to compare against, and the command says so
 * rather than refusing an installation that is being set up.
 */
export async function checkPhisStorageProviderReadiness(pool: Pool, providerId: string) {
  const instances = await listPhisServerInstances(pool, PHIS_STORAGE_READINESS_STALE_AFTER_SECONDS);
  const { serving, lacking } = findPhisInstancesLackingProvider(instances, providerId);
  if (lacking.length > 0) {
    throw new Error(
      `Provider ${providerId} is not installed on ${lacking.length} of ${serving} serving Instance(s): `
        + `${lacking.join(", ")}. Install its Add-on there first (phis addon install), then run this again.`,
    );
  }
  return { servingInstances: serving };
}
