import "server-only";

import type { PhiViewerAddonRoleClaim } from "@/lib/authorization";
import type { PhisAddonRoleDescriptor } from "./contract.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { resolvePhisAddonHeldRoles } from "./role-inclusion.ts";
import { readPhiSiteUserAddonRoles } from "@/db/server-addon-roles.mts";
import { getPool } from "@/lib/db";

/**
 * The Add-ons whose roles count on this Site, each with the roles its current manifest declares: enabled in
 * the installed state and available on the Site -- the answer dispatch, jobs and event delivery ask for
 * (`verifyPhisAddonRegistryState`), taken from the snapshot.
 *
 * The one definition of "counting". The viewer's claims, user administration's reads and saves and the
 * Add-on role catalog all ask it, so what a client is shown and what a save of that view may change are the
 * same set of Add-ons.
 */
export function listPhiCountingAddonDeclaredRoles(
  availableProviderIds: ReadonlySet<string>,
): Map<string, readonly PhisAddonRoleDescriptor[]> {
  const counting = new Map<string, readonly PhisAddonRoleDescriptor[]>();
  for (const [addonId, entry] of Object.entries(getPhisAddonInstalledManifest())) {
    if (entry.enabled && availableProviderIds.has(addonId)) {
      counting.set(addonId, entry.manifest.roles ?? []);
    }
  }
  return counting;
}

/**
 * The stored grants that count here, as they are stored: those of an Add-on that counts
 * (`listPhiCountingAddonDeclaredRoles`) naming a role its current manifest declares. Not implied and not
 * widened for a Site Admin -- the viewer expands them, user administration shows them as they are.
 */
export function filterPhiCountingAddonGrants<G extends { addonId: string; role: string }>(
  grants: readonly G[],
  availableProviderIds: ReadonlySet<string>,
): G[] {
  const counting = listPhiCountingAddonDeclaredRoles(availableProviderIds);
  return grants.filter((grant) =>
    (counting.get(grant.addonId) ?? []).some((declared) => declared.name === grant.role));
}

/** `filterPhiCountingAddonGrants`, by Add-on. */
export function selectPhiCountingAddonRoles<G extends { addonId: string; role: string }>(
  grants: readonly G[],
  availableProviderIds: ReadonlySet<string>,
): Map<string, string[]> {
  const byAddon = new Map<string, string[]>();
  for (const grant of filterPhiCountingAddonGrants(grants, availableProviderIds)) {
    byAddon.set(grant.addonId, [...(byAddon.get(grant.addonId) ?? []), grant.role]);
  }
  return byAddon;
}

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
export async function readPhiViewerAddonRoleClaims(
  siteId: number,
  userId: number,
  availableProviderIds: ReadonlySet<string>,
  /** Whether the viewer is Site Admin (`phisSiteAccessHeldBy`): they hold every declared role. */
  siteAdmin = false,
): Promise<PhiViewerAddonRoleClaim[]> {
  if (siteAdmin) {
    // Every Add-on that counts here (installed, enabled, available), every role it declares now.
    return [...listPhiCountingAddonDeclaredRoles(availableProviderIds)].flatMap(([addonId, declared]) => {
      const roles = resolvePhisAddonHeldRoles(declared, [], true);
      return roles.length > 0 ? [{ providerId: addonId as PhiViewerAddonRoleClaim["providerId"], roles }] : [];
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
