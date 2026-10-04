import "server-only";

import { randomUUID } from "node:crypto";

import type { PhisAddonBuildEntry, PhisAddonJobContext } from "./contract.ts";
import { buildPhisAddonCapabilities } from "./capabilities.ts";
import { isPhisAddonCapabilityDeliverable } from "./core-capabilities.ts";
import { deliverPhisAddonEvents } from "./event-delivery.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import {
  digestPhisAddonManifest,
  validatePhisAddonManifest,
} from "./manifest.ts";
import { verifyPhisAddonRegistryState } from "./registry-state.ts";

/**
 * Running an Add-on's declared jobs.
 *
 * There is no in-process scheduler and there should not be one. phi-server serves from several
 * instances, so a timer would fire once per instance for one intended run, and the Add-on would have to
 * defend against a concurrency nobody asked for. The operator schedules `phis addon job run` -- through
 * systemd, cron, or whatever already runs their maintenance -- which is exactly one runner by
 * construction. What the Add-on wants is documentation on the descriptor, not a promise Core keeps.
 *
 * A job has no actor. It is the Add-on acting on its own data rather than a person acting through it,
 * so the row-level ladder does not apply inside one, and `data:v1` writes with system authority. That
 * is also why a job is reachable only from the CLI: an Add-on able to start its own job from a request
 * would have built itself a way around the ladder.
 */

export type PhisAddonJobOutcome = {
  addonId: string;
  jobId: string;
  siteKey: string;
  runId: string;
  ok: boolean;
  error?: string;
};

export class PhisAddonJobError extends Error {}

function requireEntry(addonId: string): PhisAddonBuildEntry {
  const entry = getPhisAddonInstalledManifest()[addonId];
  if (!entry) {
    throw new PhisAddonJobError(`${addonId} is not installed.`);
  }
  if (!entry.enabled) {
    throw new PhisAddonJobError(`${addonId} is not enabled.`);
  }
  const validation = validatePhisAddonManifest(entry.manifest);
  if (
    !validation.manifest ||
    digestPhisAddonManifest(validation.manifest) !== entry.manifestDigest
  ) {
    throw new PhisAddonJobError(`${addonId} has an invalid build manifest.`);
  }
  for (const capability of entry.manifest.requiredCoreCapabilities) {
    if (!isPhisAddonCapabilityDeliverable(capability)) {
      throw new PhisAddonJobError(`${addonId} requires the missing Core capability ${capability}.`);
    }
  }
  return entry;
}

/**
 * Runs one declared job for one Site.
 *
 * The Site is required rather than optional. An Add-on's tables are Site-scoped, its settings and
 * secrets are per Site, and a job that quietly ran against "all of them at once" would have no Site to
 * bind its capabilities to. Running everywhere is the caller's loop, not a hidden one here.
 */
export async function runPhisAddonJob(input: {
  addonId: string;
  jobId: string;
  site: { id: number; key: string };
  signal?: AbortSignal;
}): Promise<PhisAddonJobOutcome> {
  const { addonId, jobId, site } = input;
  const runId = randomUUID();
  const entry = requireEntry(addonId);

  const descriptor = entry.manifest.jobs.find((job) => job.id === jobId);
  if (!descriptor) {
    throw new PhisAddonJobError(`${addonId} declares no job named ${jobId}.`);
  }
  // The same answer HTTP dispatch asks for: a build the registry does not describe -- above all one
  // whose migrations have not run yet -- does not get to run its job against the old schema.
  const registryState = await verifyPhisAddonRegistryState(entry, site.id);
  if (registryState === "hidden") {
    throw new PhisAddonJobError(`${addonId} is not enabled for ${site.key}.`);
  }
  if (registryState !== "ready") {
    throw new PhisAddonJobError(
      `${addonId} is not ready: the registry does not describe this build. ` +
      "Run `phis addon migrate` and `phis addon reconcile` first.",
    );
  }

  /*
   * What Core still owes this Add-on, before the job it was asked for.
   *
   * There is no scheduler here, so the operator's own is the only thing that runs on a clock -- and an
   * event whose delivery failed has to ride along with something. It runs first because the job is
   * likely to act on the state those events carry, and settling them afterwards would leave the job
   * working from what it knew one run ago. A failure is already recorded against the row it belongs to,
   * so nothing here stops the job from running.
   */
  await deliverPhisAddonEvents({ addonId, siteId: site.id });

  const runtimeModule = await entry.load();
  const handler = runtimeModule.phisAddon.jobHandlers?.[descriptor.handler];
  if (typeof handler !== "function") {
    throw new PhisAddonJobError(
      `${addonId} exports no job handler named ${descriptor.handler}.`,
    );
  }

  const controller = new AbortController();
  input.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const context: PhisAddonJobContext = {
    addonId,
    jobId,
    runId,
    site,
    capabilities: buildPhisAddonCapabilities({
      manifest: entry.manifest,
      manifestDigest: entry.manifestDigest,
      siteId: site.id,
      siteKey: site.key,
      actorUserId: null,
      systemAuthority: true,
      paymentAuthority: { kind: "job", id: jobId },
      signal: controller.signal,
    }),
    signal: controller.signal,
  };

  try {
    await handler(context);
    return { addonId, jobId, siteKey: site.key, runId, ok: true };
  } catch (error) {
    return {
      addonId,
      jobId,
      siteKey: site.key,
      runId,
      ok: false,
      error: error instanceof Error ? error.message : "The job failed.",
    };
  }
}
