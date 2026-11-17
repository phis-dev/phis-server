import "server-only";

import type { PhisAddonRoleDescriptor } from "./contract.ts";
import { PHIS_SITE_ACCESS } from "./contract.ts";
import { resolvePhisAddonHeldRoles } from "./role-inclusion.ts";
import { holdsPhisSiteAccess } from "./site-access.ts";
import { readPhisAddonUserRoles } from "@/db/server-addon-roles.mts";
import { getPool } from "@/lib/db";

/**
 * Whether a person is Site Admin on a Site, and so holds every role of every Add-on enabled there.
 * The same check that is the floor of role granting (`satisfiesPhisAddonGrantPolicy`).
 */
export function holdsEveryPhisAddonRole(siteId: number, userId: number) {
  return holdsPhisSiteAccess(siteId, userId, PHIS_SITE_ACCESS.siteAdmin);
}

/**
 * The roles one person holds in one Add-on on one Site, by `resolvePhisAddonHeldRoles`: all declared
 * ones for a Site Admin, otherwise the stored assignments and what they include. `siteAdmin` may be
 * handed in by a caller that has asked already.
 */
export async function readPhisAddonHeldRoles(input: {
  addonId: string;
  siteId: number;
  userId: number;
  declared: readonly PhisAddonRoleDescriptor[];
  siteAdmin?: boolean;
}): Promise<string[]> {
  const siteAdmin = input.siteAdmin ?? await holdsEveryPhisAddonRole(input.siteId, input.userId);
  const stored = siteAdmin
    ? []
    : await readPhisAddonUserRoles(getPool(), {
      addonId: input.addonId,
      siteId: input.siteId,
      userId: input.userId,
    });
  return resolvePhisAddonHeldRoles(input.declared, stored, siteAdmin);
}
