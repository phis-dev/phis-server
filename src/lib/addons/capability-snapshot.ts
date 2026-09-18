import "server-only";

import {
  getPhisAddonRegistryRecord,
  getPhisAddonSiteState,
} from "@/db/server-addons";
import {
  getPhisAddonBuildDigest,
  getPhisAddonInstalledManifest,
} from "@/lib/addons/installed";
import { PHIS_CORE_CAPABILITIES } from "@/lib/addons/core-capabilities";

export type { PhiCapabilityState } from "@phis/contracts/server-capabilities";
import type { PhiCapabilityState } from "@phis/contracts/server-capabilities";

type PhisCapabilitySnapshotProvider = {
  providerId: string;
  state: PhiCapabilityState;
  diagnosticCode: string | null;
  capabilities: Array<{
    id: string;
    interfaceDigest: string;
  }>;
};

/**
 * Core's own entry: everything it names, not only what it hands over.
 *
 * Two questions are asked of this list and only one of them is about receiving something. An Add-on
 * runs inside this server and a capability reaches it as an object bound to its request, so a name
 * nothing builds has to stop it -- which is what the dispatcher, the job runner, the service factory
 * and the event delivery each ask `isPhisAddonCapabilityDeliverable` before they admit one. A Site
 * Module runs in the Site and is never handed an object at all: its binding asks whether this server
 * does the thing, and `authentication:v1` is exactly such a name. Core performs authentication; it
 * simply has nothing to give an Add-on about it.
 *
 * Answering the Module's question with the Add-on's answer switched the first-party Auth Module off,
 * and with it the login route every Area behind a session sends people to. SERVER_ADDONS.md section 13
 * states what stands here: every id appears in this snapshot, and only the delivered ones are bound to
 * an Add-on's context.
 */
export function createPhisCoreCapabilityProvider(): PhisCapabilitySnapshotProvider {
  return {
    providerId: "@phis/server/core",
    state: "available",
    diagnosticCode: null,
    capabilities: [...PHIS_CORE_CAPABILITIES],
  };
}

export async function buildPhisCapabilitySnapshot(siteId: number) {
  const providers: PhisCapabilitySnapshotProvider[] = [createPhisCoreCapabilityProvider()];

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
