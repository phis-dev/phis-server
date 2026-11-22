import "server-only";

import type { PhiViewerAddonRoleClaim } from "@/lib/authorization";
import { PHIS_SITE_ACCESS, type PhisAddonRoleDescriptor } from "./contract.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { resolvePhisAddonHeldRoles, type PhisSiteAccessHolder } from "./role-inclusion.ts";
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
 * A Site Admin holds every declared role of every such Add-on, stored or not, and a holder of a Site access
 * every role an Add-on hangs on it with `impliedBy` (`resolvePhisAddonHeldRoles`). Both are answered from the
 * authorization snapshot the caller already read, never by reading it again.
 *
 * These travel to the browser with the rest of the viewer. That is not a leak: they are the viewer's own
 * roles, and the client uses them to decide what to show. Whether the request behind the link is allowed
 * is decided again on the server, which is the only decision that counts.
 */
export async function readPhiViewerAddonRoleClaims(
  siteId: number,
  userId: number,
  availableProviderIds: ReadonlySet<string>,
  /** The viewer's Site accesses (`phisSiteAccessHolderOf` over the snapshot the request read). */
  holdsSiteAccess: PhisSiteAccessHolder,
): Promise<PhiViewerAddonRoleClaim[]> {
  const counting = listPhiCountingAddonDeclaredRoles(availableProviderIds);
  // A Site Admin holds every role whatever is stored, so nothing stored is read for one.
  const grants = holdsSiteAccess(PHIS_SITE_ACCESS.siteAdmin)
    ? new Map<string, string[]>()
    : selectPhiCountingAddonRoles(await readPhiSiteUserAddonRoles(getPool(), { siteId, userId }), availableProviderIds);

  // Granted, implied by a Site access, and what those include: a viewer holding `manager` is shown what a
  // `clerk` sees, as the server answers. In the order the Add-ons count, roles in declaration order.
  const claims: PhiViewerAddonRoleClaim[] = [];
  for (const [addonId, declared] of counting) {
    const roles = resolvePhisAddonHeldRoles(declared, grants.get(addonId) ?? [], holdsSiteAccess);
    if (roles.length > 0) {
      claims.push({ providerId: addonId as PhiViewerAddonRoleClaim["providerId"], roles });
    }
  }
  return claims;
}
