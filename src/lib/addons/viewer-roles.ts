import "server-only";

import type { PhiViewerAddonRoleClaim } from "@/lib/authorization";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { resolvePhisAddonHeldRoles } from "./role-inclusion.ts";
import { readPhiSiteUserAddonRoles } from "@/db/server-addon-roles.mts";
import { getPool } from "@/lib/db";

/**
 * The Add-on roles this viewer holds, in the shape an access policy names.
 *
 * The same filter the `roles:v1` capability applies, for the same reason: only what the current manifest
 * declares is handed over, so a grant left behind by an older version cannot quietly keep opening a
 * navigation entry. And only Add-ons enabled for this Site -- a role of something switched off here
 * should not gate anything here.
 *
 * Whether an Add-on is enabled for this Site is the capability snapshot's `available`, read once per
 * request by `getEffectiveUserSiteAuthorization` and handed in. Asking the registry here again cost two
 * statements per Add-on with a grant, one after the other, on every signed-in page view.
 *
 * A Site Admin holds every declared role of every such Add-on, stored or not (`resolvePhisAddonHeldRoles`).
 *
 * These travel to the browser with the rest of the viewer. That is not a leak: they are the viewer's own
 * roles, and the client uses them to decide what to show. Whether the request behind the link is allowed
 * is decided again on the server, which is the only decision that counts.
 */
/**
 * The stored grants that count here, by Add-on: those of an Add-on enabled in the installed state and
 * available on the Site -- the answer dispatch, jobs and event delivery ask for
 * (`verifyPhisAddonRegistryState`), taken from the snapshot -- naming a role its current manifest declares. Stored, not implied -- the viewer
 * expands them, user administration shows them as they are.
 */
export function selectPhiCountingAddonRoles<G extends { addonId: string; role: string }>(
  grants: readonly G[],
  availableProviderIds: ReadonlySet<string>,
): Map<string, string[]> {
  const installed = getPhisAddonInstalledManifest();
  const byAddon = new Map<string, string[]>();
  for (const grant of grants) {
    const entry = installed[grant.addonId];
    if (!entry?.enabled || !availableProviderIds.has(grant.addonId)) {
      continue;
    }
    if (!(entry.manifest.roles ?? []).some((declared) => declared.name === grant.role)) {
      continue;
    }
    byAddon.set(grant.addonId, [...(byAddon.get(grant.addonId) ?? []), grant.role]);
  }
  return byAddon;
}

export async function readPhiViewerAddonRoleClaims(
  siteId: number,
  userId: number,
  availableProviderIds: ReadonlySet<string>,
  /** Whether the viewer is Site Admin (`phisSiteAccessHeldBy`): they hold every declared role. */
  siteAdmin = false,
): Promise<PhiViewerAddonRoleClaim[]> {
  if (siteAdmin) {
    // Every Add-on that counts here (installed, enabled, available), every role it declares now.
    return Object.entries(getPhisAddonInstalledManifest()).flatMap(([addonId, entry]) => {
      const roles = resolvePhisAddonHeldRoles(entry.manifest.roles ?? [], [], true);
      return entry.enabled && availableProviderIds.has(addonId) && roles.length > 0
        ? [{ providerId: addonId as PhiViewerAddonRoleClaim["providerId"], roles }]
        : [];
    });
  }
  const grants = await readPhiSiteUserAddonRoles(getPool(), { siteId, userId });
  if (grants.length === 0) {
    return [];
  }

  const installed = getPhisAddonInstalledManifest();
  // Granted and implied: a viewer holding `manager` is shown what a `clerk` sees, as the server answers.
  const byAddon = new Map<string, string[]>();
  for (const [addonId, granted] of selectPhiCountingAddonRoles(grants, availableProviderIds)) {
    const held = resolvePhisAddonHeldRoles(installed[addonId]!.manifest.roles ?? [], granted, false);
    if (held.length > 0) {
      byAddon.set(addonId, held);
    }
  }

  return [...byAddon].map(([addonId, roles]) => ({
    providerId: addonId as PhiViewerAddonRoleClaim["providerId"],
    roles,
  }));
}
