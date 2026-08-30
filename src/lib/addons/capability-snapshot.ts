import "server-only";

import { createHash } from "node:crypto";

import {
  getPhiServerAddonRegistryRecord,
  getPhiServerAddonSiteState,
} from "@/db/server-addons";
import { getPhiServerAddonInstalledManifest } from "@/lib/addons/installed";
import { PHI_SERVER_CORE_CAPABILITIES } from "@/lib/addons/core-capabilities";

export type PhiServerCapabilityState =
  | "available"
  | "missing"
  | "disabled"
  | "incompatible"
  | "misconfigured"
  | "unavailable";

function getBuildDigest() {
  const buildState = Object.entries(getPhiServerAddonInstalledManifest())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([addonId, entry]) => ({
      addonId,
      enabled: entry.enabled,
      manifestDigest: entry.manifestDigest,
      packageVersion: entry.manifest.packageVersion,
    }));
  return createHash("sha256")
    .update(JSON.stringify(buildState))
    .digest("hex");
}

export async function buildPhiServerCapabilitySnapshot(siteId: number) {
  const providers: Array<{
    providerId: string;
    state: PhiServerCapabilityState;
    diagnosticCode: string | null;
    capabilities: Array<{
      id: string;
      interfaceDigest: string;
    }>;
  }> = [
    {
      providerId: "@phis/phi-server/core",
      state: "available",
      diagnosticCode: null,
      capabilities: [...PHI_SERVER_CORE_CAPABILITIES],
    },
  ];

  for (const [addonId, entry] of Object.entries(
    getPhiServerAddonInstalledManifest(),
  ).sort(([left], [right]) => left.localeCompare(right))) {
    let state: PhiServerCapabilityState = "available";
    let diagnosticCode: string | null = null;

    if (!entry.enabled) {
      state = "disabled";
      diagnosticCode = "build_disabled";
    } else {
      const registry = await getPhiServerAddonRegistryRecord(addonId);
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
        const siteState = await getPhiServerAddonSiteState(addonId, siteId);
        if (!siteState?.requestedEnabled) {
          state = "disabled";
          diagnosticCode = "site_disabled";
        } else if (siteState.configurationStatus !== "ready") {
          state = "misconfigured";
          diagnosticCode =
            siteState.diagnosticCode ?? "site_configuration_invalid";
        } else if (siteState.effectiveStatus !== "available") {
          state = siteState.effectiveStatus as PhiServerCapabilityState;
          diagnosticCode =
            siteState.diagnosticCode ?? "site_effective_state_unavailable";
        }
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
    buildManifestDigest: getBuildDigest(),
    providers,
  };
}
