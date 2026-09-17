import "server-only";

import {
  getPhisAddonRegistryRecord,
  getPhisAddonSiteState,
} from "@/db/server-addons";
import {
  getPhisAddonBuildDigest,
  getPhisAddonInstalledManifest,
} from "@/lib/addons/installed";
import {
  PHIS_CORE_CAPABILITIES,
  isPhisAddonCapabilityDeliverable,
} from "@/lib/addons/core-capabilities";

export type { PhiCapabilityState } from "@phis/contracts/server-capabilities";
import type { PhiCapabilityState } from "@phis/contracts/server-capabilities";

export async function buildPhisCapabilitySnapshot(siteId: number) {
  const providers: Array<{
    providerId: string;
    state: PhiCapabilityState;
    diagnosticCode: string | null;
    capabilities: Array<{
      id: string;
      interfaceDigest: string;
    }>;
  }> = [
    {
      providerId: "@phis/server/core",
      state: "available",
      diagnosticCode: null,
      /*
       * What Core can hand over, not what it can name.
       *
       * The snapshot is what a Site's Modules are activated against, and reporting the whole catalogue
       * made a Module requiring a reserved name activate against a capability nothing builds -- the
       * same mistake the dispatcher stopped making when it started asking this set. A reserved name is
       * absent here rather than reported as available, so the Module stays off and says why.
       */
      capabilities: PHIS_CORE_CAPABILITIES.filter((capability) =>
        isPhisAddonCapabilityDeliverable(capability.id)),
    },
  ];

  for (const [addonId, entry] of Object.entries(
    getPhisAddonInstalledManifest(),
  ).sort(([left], [right]) => left.localeCompare(right))) {
    let state: PhiCapabilityState = "available";
    let diagnosticCode: string | null = null;

    if (!entry.enabled) {
      state = "disabled";
      diagnosticCode = "build_disabled";
    } else {
      const registry = await getPhisAddonRegistryRecord(addonId);
      if (!registry) {
        state = "unavailable";
        diagnosticCode = "registry_missing";
      } else if (!registry.globallyEnabled) {
        state = "disabled";
        diagnosticCode = "globally_disabled";
      } else if (
        registry.packageName !== entry.manifest.packageName ||
        registry.packageVersion !== entry.manifest.packageVersion ||
        registry.serverAbi !== entry.manifest.serverAbi ||
        registry.manifestDigest !== entry.manifestDigest ||
        registry.migrationVersion < entry.manifest.migrationVersion
      ) {
        state = "incompatible";
        diagnosticCode = "deployment_mismatch";
      } else {
        const siteState = await getPhisAddonSiteState(addonId, siteId);
        if (!siteState?.requestedEnabled) {
          state = "disabled";
          diagnosticCode = "site_disabled";
        } else if (siteState.configurationStatus !== "ready") {
          state = "misconfigured";
          diagnosticCode =
            siteState.diagnosticCode ?? "site_configuration_invalid";
        }
        /*
         * `effective_status` is deliberately not consulted here.
         *
         * Everything it could say has just been decided above, from the sources that decide it: the
         * desired state, the registry, the digests, the migration level, the Site's request and its
         * configuration. Reading a stored verdict back on top of that made the answer depend on when it
         * was last written -- and since nothing ever wrote it, the column sat at its default and every
         * Add-on looked unavailable on every Site, which is why no dependent Module could activate
         * anywhere.
         *
         * The column stays, written by `reconcile`, as a diagnosis an operator can read without
         * reproducing this function. It is a record of the last check, not an input to the next one.
         */
      }
    }

    providers.push({
      providerId: addonId,
      state,
      diagnosticCode,
      capabilities: entry.manifest.capabilities,
    });
  }

  return {
    releaseBuildId: process.env.PHIS_RELEASE_ID?.trim() || null,
    buildManifestDigest: getPhisAddonBuildDigest(),
    providers,
  };
}
