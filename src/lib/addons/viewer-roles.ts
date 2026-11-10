import "server-only";

import type { PhiViewerAddonRoleClaim } from "@/lib/authorization";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { expandPhisAddonHeldRoles } from "./role-inclusion.ts";
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
 * These travel to the browser with the rest of the viewer. That is not a leak: they are the viewer's own
 * roles, and the client uses them to decide what to show. Whether the request behind the link is allowed
 * is decided again on the server, which is the only decision that counts.
 */
export async function readPhiViewerAddonRoleClaims(
  siteId: number,
  userId: number,
  availableProviderIds: ReadonlySet<string>,
): Promise<PhiViewerAddonRoleClaim[]> {
  const grants = await readPhiSiteUserAddonRoles(getPool(), { siteId, userId });
  if (grants.length === 0) {
    return [];
  }

  const installed = getPhisAddonInstalledManifest();
  const grantedByAddon = new Map<string, string[]>();
  for (const grant of grants) {
    if (!installed[grant.addonId]?.enabled) {
      continue;
    }
    grantedByAddon.set(grant.addonId, [...(grantedByAddon.get(grant.addonId) ?? []), grant.role]);
  }
  // Granted and implied: a viewer holding `manager` is shown what a `clerk` sees, as the server answers.
  const byAddon = new Map<string, string[]>();
  for (const [addonId, granted] of grantedByAddon) {
    const held = expandPhisAddonHeldRoles(installed[addonId]!.manifest.roles ?? [], granted);
    if (held.length > 0) {
      byAddon.set(addonId, held);
    }
  }

  const claims: PhiViewerAddonRoleClaim[] = [];
  for (const [addonId, roles] of byAddon) {
    // The same answer dispatch, jobs and event delivery ask for (`verifyPhisAddonRegistryState`), taken
    // from the snapshot: switched off in the registry, off for this Site, or a build the registry does
    // not describe, its roles open nothing here either.
    if (!availableProviderIds.has(addonId)) {
      continue;
    }
    claims.push({ providerId: addonId as PhiViewerAddonRoleClaim["providerId"], roles });
  }
  return claims;
}
