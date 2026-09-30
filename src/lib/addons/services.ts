import "server-only";

import { getPhisAddonInstalledManifest } from "@/lib/addons/installed";
import { isPhisAddonCapabilityDeliverable } from "@/lib/addons/core-capabilities";
import { isPhisServiceInterfaceCurrent } from "@/lib/addons/core-services";
import { verifyPhisAddonRegistryState } from "@/lib/addons/registry-state";
import {
  digestPhisAddonManifest,
  validatePhisAddonManifest,
} from "@/lib/addons/manifest";
import type {
  PhisAddonServiceFactory,
  PhisAddonServiceProviderDescriptor,
} from "@/lib/addons/contract";

/**
 * Finds the Add-on that implements one Core-owned service, and hands back its factory.
 *
 * This is the static path section 7 requires: the build manifest is the only authority for loadable
 * code, so a provider key coming out of a database row selects an entry that a build already contains
 * rather than becoming an import specifier. An Add-on present only in the database is not loadable,
 * and one present only in the build is not effective until the registry agrees with it.
 *
 * The checks are the dispatcher's, minus the ones that need a request. A Provider is reached far from
 * any route -- an image variant regenerating, a delete guard cleaning up -- so it cannot rely on
 * having passed through one.
 */

export class PhiServiceProviderUnavailableError extends Error {
  readonly reason: string;

  constructor(serviceKind: string, providerKey: string, reason: string) {
    super(`Service provider "${providerKey}" for ${serviceKind} is unavailable: ${reason}`);
    this.name = "PhiServiceProviderUnavailableError";
    this.reason = reason;
  }
}

type ResolvedServiceProvider = {
  addonId: string;
  descriptor: PhisAddonServiceProviderDescriptor;
  factory: PhisAddonServiceFactory;
};

/**
 * Keyed by `serviceKind:providerKey:manifestDigest`.
 *
 * The digest belongs in the key now that an installation is no longer a build: an upgraded Add-on is
 * a different manifest, and a factory resolved from the version it replaced must not answer for it.
 * An entry from a superseded version simply stops being looked up.
 */
const resolvedProviders = new Map<string, ResolvedServiceProvider>();

function findDeclaringEntry(serviceKind: string, providerKey: string) {
  for (const [addonId, entry] of Object.entries(getPhisAddonInstalledManifest())) {
    const descriptor = entry.manifest.serviceProviders.find(
      (candidate) =>
        candidate.serviceKind === serviceKind && candidate.providerKey === providerKey,
    );
    if (descriptor) {
      return { addonId, entry, descriptor };
    }
  }
  return null;
}

/**
 * Which installed Add-ons offer an implementation of one service kind.
 *
 * For an operator choosing between them. It reports what each one is rather than filtering to the
 * usable ones, because "installed but disabled" and "built against another interface" are answers a
 * person configuring this needs to see -- a list that silently omitted them would leave somebody
 * wondering where their Add-on went.
 *
 * Not a resolution. Nothing is loaded and no factory runs; that is `resolvePhisServiceProvider`, which
 * checks all of this again at the moment it matters.
 */
export function listPhisServiceProviders(serviceKind: string) {
  const providers: Array<{
    addonId: string;
    providerKey: string;
    enabled: boolean;
    interfaceCurrent: boolean;
  }> = [];
  for (const [addonId, entry] of Object.entries(getPhisAddonInstalledManifest())) {
    for (const descriptor of entry.manifest.serviceProviders) {
      if (descriptor.serviceKind !== serviceKind) {
        continue;
      }
      providers.push({
        addonId,
        providerKey: descriptor.providerKey,
        enabled: entry.enabled,
        interfaceCurrent: isPhisServiceInterfaceCurrent(
          descriptor.serviceKind,
          descriptor.interfaceDigest,
        ),
      });
    }
  }
  return providers;
}

export async function resolvePhisServiceProvider(
  serviceKind: string,
  providerKey: string,
  options?: { siteId?: number | null },
): Promise<ResolvedServiceProvider> {
  const found = findDeclaringEntry(serviceKind, providerKey);
  if (!found) {
    throw new PhiServiceProviderUnavailableError(serviceKind, providerKey, "no installed Add-on declares it");
  }
  const { addonId, entry, descriptor } = found;
  const cacheKey = `${serviceKind}:${providerKey}:${entry.manifestDigest}`;
  const cached = resolvedProviders.get(cacheKey);
  if (!entry.enabled) {
    throw new PhiServiceProviderUnavailableError(serviceKind, providerKey, `${addonId} is disabled`);
  }
  if (!isPhisServiceInterfaceCurrent(descriptor.serviceKind, descriptor.interfaceDigest)) {
    throw new PhiServiceProviderUnavailableError(
      serviceKind,
      providerKey,
      `${addonId} was built against a different ${serviceKind} interface`,
    );
  }

  const manifestValidation = validatePhisAddonManifest(entry.manifest);
  if (
    !manifestValidation.manifest ||
    digestPhisAddonManifest(manifestValidation.manifest) !== entry.manifestDigest
  ) {
    throw new PhiServiceProviderUnavailableError(serviceKind, providerKey, `${addonId} has an invalid build manifest`);
  }
  for (const capability of [
    ...entry.manifest.requiredCoreCapabilities,
    ...descriptor.requiredCoreCapabilities,
  ]) {
    if (!isPhisAddonCapabilityDeliverable(capability)) {
      throw new PhiServiceProviderUnavailableError(
        serviceKind,
        providerKey,
        `${addonId} requires the missing Core capability ${capability}`,
      );
    }
  }

  // The same registry verdict HTTP dispatch, jobs and event delivery ask for, so a provider cannot run
  // against a registry row those three would refuse.
  const registryState = await verifyPhisAddonRegistryState(entry, options?.siteId ?? null);
  if (registryState === "hidden") {
    throw new PhiServiceProviderUnavailableError(
      serviceKind,
      providerKey,
      `${addonId} is disabled globally or not enabled for this Site`,
    );
  }
  if (registryState !== "ready") {
    throw new PhiServiceProviderUnavailableError(
      serviceKind,
      providerKey,
      `${addonId} is not ready: the registry does not describe this build`,
    );
  }

  if (cached) {
    return cached;
  }

  const runtimeModule = await entry.load();
  const runtime = runtimeModule.phisAddon;
  const runtimeValidation = validatePhisAddonManifest(runtime?.manifest);
  if (
    !runtimeValidation.manifest ||
    digestPhisAddonManifest(runtimeValidation.manifest) !== entry.manifestDigest
  ) {
    throw new PhiServiceProviderUnavailableError(
      serviceKind,
      providerKey,
      `${addonId} shipped a runtime manifest that differs from its build manifest`,
    );
  }
  const factory = runtime.serviceFactories?.[descriptor.factoryExport];
  if (typeof factory !== "function") {
    throw new PhiServiceProviderUnavailableError(
      serviceKind,
      providerKey,
      `${addonId} exports no service factory named ${descriptor.factoryExport}`,
    );
  }

  const resolved: ResolvedServiceProvider = { addonId, descriptor, factory };
  resolvedProviders.set(cacheKey, resolved);
  return resolved;
}
