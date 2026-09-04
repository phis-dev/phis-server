import "server-only";

import { PHIS_CORE_CAPABILITIES } from "@/lib/addons/core-capabilities";
import {
  getPhisAddonBuildDigest,
  getPhisAddonInstalledManifest,
} from "@/lib/addons/installed";
import { getDefaultServerPhiRoot } from "@/lib/config-files";
import { resolvePhisInstanceId } from "@/lib/instance-identity.mts";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { isPhiSecretStoreReadable } from "@/lib/secrets/resolver";
import {
  recordPhisServerInstance,
  type PhisServerInstanceReport,
} from "@/db/server-instances.mts";
import { getPool } from "@/lib/db";

/**
 * How often an instance says it is still here.
 *
 * The interval is documentation for the operator rather than a promise: it decides how quickly a
 * process that died without draining stops looking ready, and nothing schedules work off it. A reader
 * decides for itself what counts as stale, which is why that threshold is its argument and not a
 * constant shared with this one.
 */
export const PHIS_INSTANCE_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * What this instance holds, as opposed to what the registry says the installation wants.
 *
 * Everything here is read locally on purpose. The whole point of the report is that it can disagree
 * with the shared registry -- an instance that has not received an artifact must be able to say so, and
 * a report assembled from the database could not.
 */
export function buildPhisInstanceReport(): PhisServerInstanceReport {
  const installed = getPhisAddonInstalledManifest();

  const addonPackages: Record<string, string> = {};
  const capabilityDigests: Record<string, string> = {};
  for (const capability of PHIS_CORE_CAPABILITIES) {
    capabilityDigests[capability.id] = capability.interfaceDigest;
  }
  for (const [addonId, entry] of Object.entries(installed)) {
    addonPackages[addonId] = entry.manifest.packageVersion;
    for (const capability of entry.manifest.capabilities) {
      capabilityDigests[capability.id] = capability.interfaceDigest;
    }
  }

  return {
    instanceId: resolvePhisInstanceId(getDefaultServerPhiRoot()),
    releaseBuildId: process.env.PHIS_RELEASE_ID?.trim() || "unknown",
    addonManifestDigest: getPhisAddonBuildDigest(),
    addonPackages,
    capabilityDigests,
    // Section 16: an instance that cannot resolve its root key answers no requests rather than failing
    // every one that needs a secret, so it must not report itself ready either.
    ready: isPhiSecretStoreReadable(),
  };
}

let timer: NodeJS.Timeout | null = null;

async function beat() {
  try {
    await recordPhisServerInstance(getPool(), buildPhisInstanceReport());
  } catch (error) {
    // A heartbeat that cannot reach the database is not a reason to stop serving what does not need it.
    // The next tick retries, and until one succeeds the row simply goes stale, which is the honest
    // report: nobody can currently confirm this instance.
    logRuntimeEvent("error", "instance.heartbeat.failed", {
      error: normalizeLogThrowable(error),
    });
  }
}

/**
 * Starts reporting this instance.
 *
 * The timer is unreferenced so it never holds the process open by itself. There is deliberately no
 * shutdown handler here: Next installs its own signal handling and exits, and a handler racing it would
 * usually lose and always look as though it had not. Withdrawing readiness on the way down is
 * `phis instance drain`, run by whatever stops the process -- which is also the right order, because
 * traffic should stop before the process does. Until that runs, or where nothing runs it, the staleness
 * window is what says an instance is gone.
 */
export function startPhisInstanceHeartbeat() {
  if (timer) {
    return;
  }

  void beat();
  timer = setInterval(() => {
    void beat();
  }, PHIS_INSTANCE_HEARTBEAT_INTERVAL_MS);
  timer.unref();
}
