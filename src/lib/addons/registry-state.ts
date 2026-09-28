import "server-only";

import type { PhisAddonBuildEntry } from "./contract.ts";
import { getPhisAddonRegistryRecord, isPhisAddonEnabledForSite } from "@/db/server-addons";

/**
 * Whether the build in this process and the registry row agree enough to run the Add-on's code.
 *
 * One answer for every way in. HTTP dispatch asked it; jobs and event delivery did not, so a job run
 * between `phis addon upgrade` and `phis addon migrate` executed the new code against the old schema.
 * `hidden` is an Add-on switched off, globally or for the Site; `unavailable` is one whose registry
 * row is missing or describes another build -- a different package, ABI or manifest, or a migration
 * version behind what this build expects.
 */
export async function verifyPhisAddonRegistryState(
  entry: PhisAddonBuildEntry,
  siteId: number | null,
) {
  const registry = await getPhisAddonRegistryRecord(entry.manifest.addonId);
  if (!registry) {
    return "unavailable" as const;
  }
  if (!registry.globallyEnabled) {
    return "hidden" as const;
  }
  if (
    registry.packageName !== entry.manifest.packageName ||
    registry.packageVersion !== entry.manifest.packageVersion ||
    registry.serverAbi !== entry.manifest.serverAbi ||
    registry.manifestDigest !== entry.manifestDigest ||
    registry.migrationVersion < entry.manifest.migrationVersion
  ) {
    return "unavailable" as const;
  }
  if (
    siteId !== null &&
    !(await isPhisAddonEnabledForSite(entry.manifest.addonId, siteId))
  ) {
    return "hidden" as const;
  }
  return "ready" as const;
}
