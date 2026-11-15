import {
  PHIS_ADDON_EVENTS,
  type PhisAddonManifestV1,
  type PhisEntitlementKind,
  type PhisEntitlementKindId,
} from "@phis/contracts/addon";

/**
 * The entitlement kinds and listeners an installed-manifest reading yields.
 *
 * Pure, and not `server-only`: the server reads the entries from `getPhisAddonInstalledManifest()`, the
 * CLI from the desired state on disk, and both get the same answer from the same shape.
 */
export type PhisInstalledManifestEntries = Record<
  string,
  { enabled: boolean; manifest: Pick<PhisAddonManifestV1, "entitlementKinds" | "eventHandlers"> }
>;

const KIND_KEY_PATTERN = /^[a-z][a-z0-9.-]*$/;

/** The kinds the enabled Add-ons declare: the installed manifests are the catalogue. */
export function listEntitlementKindsOf(entries: PhisInstalledManifestEntries): PhisEntitlementKind[] {
  const kinds: PhisEntitlementKind[] = [];
  for (const [addonId, entry] of Object.entries(entries)) {
    if (!entry.enabled) continue;
    for (const kind of entry.manifest.entitlementKinds ?? []) {
      kinds.push({
        id: `${addonId}:${kind.key}` as PhisEntitlementKindId,
        addonId,
        title: kind.title,
        description: kind.description ?? null,
        counted: kind.counted === true,
      });
    }
  }
  return kinds;
}

/** The enabled Add-ons that declare a handler for `entitlement.changed`. */
export function listEntitlementListenersOf(entries: PhisInstalledManifestEntries): string[] {
  return Object.entries(entries)
    .filter(([, entry]) => entry.enabled
      && (entry.manifest.eventHandlers ?? []).some((handler) => handler.event === PHIS_ADDON_EVENTS.entitlementChanged))
    .map(([addonId]) => addonId);
}

/** Whether a string is a kind\x27s id by its grammar; whether anybody declares it is another question. */
export function isPhisEntitlementKindId(value: unknown): value is PhisEntitlementKindId {
  if (typeof value !== "string" || !value.startsWith("@")) return false;
  const separator = value.lastIndexOf(":");
  return separator > 0 && value.slice(0, separator).includes("/") && KIND_KEY_PATTERN.test(value.slice(separator + 1));
}
