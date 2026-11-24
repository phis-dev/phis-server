import "server-only";

import { listPhisAddonUsersGrants } from "@/db/users-grants.mts";
import { getPool } from "@/lib/db";
import { getPhisAddonInstalledManifest } from "@/lib/addons/installed";
import { describePhisAddonUsersAccess } from "@/lib/addons/users-access";

/**
 * The Site Admin's view of `users:v1` background access (`/api/site/admin/users-access`): every installed
 * Add-on requiring the capability, enabled or not -- a grant may be given before it runs -- with the Site's
 * grant beside what its manifest asks.
 */
export function listInstalledPhisUsersReaders() {
  return Object.entries(getPhisAddonInstalledManifest())
    .map(([addonId, entry]) => ({ addonId, manifest: entry.manifest }))
    .sort((left, right) => left.addonId.localeCompare(right.addonId));
}

export async function readSitePhisUsersAccess(siteId: number, addonId?: string) {
  const readers = listInstalledPhisUsersReaders().filter((entry) => addonId === undefined || entry.addonId === addonId);
  return describePhisAddonUsersAccess(readers, await listPhisAddonUsersGrants(getPool(), siteId));
}
