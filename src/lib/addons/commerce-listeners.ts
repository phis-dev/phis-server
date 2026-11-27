import { PHIS_ADDON_EVENTS, PHIS_CORE_CAPABILITIES, PhisAddonInstallationFlag, type PhisAddonManifestV1 } from "@phis/contracts/addon";

/**
 * The listeners of Core's commerce and user events, and what an installed-manifest reading yields.
 *
 * Pure, and not `server-only`: the server reads the entries from `getPhisAddonInstalledManifest()`, the
 * CLI from the desired state on disk, and both get the same answer from the same shape.
 */
export type PhisInstalledManifestEntries = Record<
  string,
  { flags: number; manifest: Pick<PhisAddonManifestV1, "eventHandlers" | "requiredCoreCapabilities"> }
>;

function listenersOf(entries: PhisInstalledManifestEntries, event: string): string[] {
  return Object.entries(entries)
    .filter(([, entry]) => (entry.flags & PhisAddonInstallationFlag.Enabled) !== 0 && (entry.manifest.eventHandlers ?? []).some((handler) => handler.event === event))
    .map(([addonId]) => addonId);
}

/** The enabled Add-ons that declare a handler for `entitlement.changed`. */
export const listEntitlementListenersOf = (entries: PhisInstalledManifestEntries) =>
  listenersOf(entries, PHIS_ADDON_EVENTS.entitlementChanged);

/** The enabled Add-ons that declare a handler for `product.changed`. */
export const listProductListenersOf = (entries: PhisInstalledManifestEntries) =>
  listenersOf(entries, PHIS_ADDON_EVENTS.productChanged);

/**
 * The enabled Add-ons that require `users:v1` and declare a handler for a user event: a person's events
 * reach only an Add-on that may read people at all, never one that merely listens.
 */
export const listUserListenersOf = (entries: PhisInstalledManifestEntries, event: "user.registered" | "user.changed") =>
  listenersOf(entries, event).filter((addonId) =>
    entries[addonId]!.manifest.requiredCoreCapabilities.includes(PHIS_CORE_CAPABILITIES.users));
