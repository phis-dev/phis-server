import { PHIS_ADDON_EVENTS, type PhisAddonManifestV1 } from "@phis/contracts/addon";

/**
 * The listeners of Core's two commerce events, and what an installed-manifest reading yields.
 *
 * Pure, and not `server-only`: the server reads the entries from `getPhisAddonInstalledManifest()`, the
 * CLI from the desired state on disk, and both get the same answer from the same shape.
 */
export type PhisInstalledManifestEntries = Record<
  string,
  { enabled: boolean; manifest: Pick<PhisAddonManifestV1, "eventHandlers"> }
>;

function listenersOf(entries: PhisInstalledManifestEntries, event: string): string[] {
  return Object.entries(entries)
    .filter(([, entry]) => entry.enabled && (entry.manifest.eventHandlers ?? []).some((handler) => handler.event === event))
    .map(([addonId]) => addonId);
}

/** The enabled Add-ons that declare a handler for `entitlement.changed`. */
export const listEntitlementListenersOf = (entries: PhisInstalledManifestEntries) =>
  listenersOf(entries, PHIS_ADDON_EVENTS.entitlementChanged);

/** The enabled Add-ons that declare a handler for `product.changed`. */
export const listProductListenersOf = (entries: PhisInstalledManifestEntries) =>
  listenersOf(entries, PHIS_ADDON_EVENTS.productChanged);
