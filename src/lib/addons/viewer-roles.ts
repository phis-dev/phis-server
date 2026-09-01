import "server-only";

import type { PhiViewerAddonRoleClaim } from "@/lib/authorization";
import { getPhiServerAddonInstalledManifest } from "./installed.ts";
import { isPhiServerAddonEnabledForSite } from "@/db/server-addons";
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
 * These travel to the browser with the rest of the viewer. That is not a leak: they are the viewer's own
 * roles, and the client uses them to decide what to show. Whether the request behind the link is allowed
 * is decided again on the server, which is the only decision that counts.
 */
export async function readPhiViewerAddonRoleClaims(
  siteId: number,
  userId: number,
): Promise<PhiViewerAddonRoleClaim[]> {
  const grants = await readPhiSiteUserAddonRoles(getPool(), { siteId, userId });
  if (grants.length === 0) {
    return [];
  }

  const installed = getPhiServerAddonInstalledManifest();
  const byAddon = new Map<string, string[]>();
  for (const grant of grants) {
    const entry = installed[grant.addonId];
    if (!entry?.enabled) {
      continue;
    }
    const declared = entry.manifest.roles ?? [];
    if (!declared.some((role) => role.name === grant.role)) {
      continue;
    }
    byAddon.set(grant.addonId, [...(byAddon.get(grant.addonId) ?? []), grant.role]);
  }

  const claims: PhiViewerAddonRoleClaim[] = [];
  for (const [addonId, roles] of byAddon) {
    if (!await isPhiServerAddonEnabledForSite(addonId, siteId)) {
      continue;
    }
    claims.push({ providerId: addonId as PhiViewerAddonRoleClaim["providerId"], roles });
  }
  return claims;
}
