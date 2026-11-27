import "server-only";

import { PHIS_SITE_ACCESS, type PhisSiteAccess } from "./contract.ts";
import type { PhisSiteAccessHolder } from "./role-inclusion.ts";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import {
  canPhiViewerAccess,
  PHI_CORE_ROLE_PROVIDER_ID,
  PHI_ACCESS_ACCOUNTING,
  PHI_ACCESS_BILLING,
  PHI_ACCESS_CONTENT_EDITING,
  PHI_ACCESS_SITE_MAINTENANCE,
  PHI_ACCESS_PUBLISHING,
  PHI_ACCESS_SITE_ADMIN,
  PHI_ACCESS_SITE_MEDIA,
  PHI_ACCESS_STRUCTURE_AUTHORING,
  PHI_ACCESS_SUPPORT,
  type PhiViewerAccessPolicy,
  type PhiViewerGroupClaim,
  type PhiViewerRoleClaim,
} from "@/lib/authorization";

/**
 * The Site accesses an Add-on may name, and the Core policy each one means.
 *
 * `authorization:v1` answering `hasSiteAccess` and the role-granting check asking whether a person may
 * hand out a role both read this table. They used to keep a copy each, with the membership lookup and
 * the evaluator call beside it; a ninth access added to one would have been an access the other did not
 * know, and an Add-on's question and its grant rule would have started to disagree.
 */
export const PHIS_SITE_ACCESS_POLICIES: Readonly<Record<PhisSiteAccess, PhiViewerAccessPolicy>> = {
  [PHIS_SITE_ACCESS.siteAdmin]: PHI_ACCESS_SITE_ADMIN,
  [PHIS_SITE_ACCESS.siteMaintenance]: PHI_ACCESS_SITE_MAINTENANCE,
  [PHIS_SITE_ACCESS.structureAuthoring]: PHI_ACCESS_STRUCTURE_AUTHORING,
  [PHIS_SITE_ACCESS.contentEditing]: PHI_ACCESS_CONTENT_EDITING,
  [PHIS_SITE_ACCESS.publishing]: PHI_ACCESS_PUBLISHING,
  [PHIS_SITE_ACCESS.siteMedia]: PHI_ACCESS_SITE_MEDIA,
  [PHIS_SITE_ACCESS.support]: PHI_ACCESS_SUPPORT,
  [PHIS_SITE_ACCESS.accounting]: PHI_ACCESS_ACCOUNTING,
};

/**
 * Whether an authorization snapshot holds one of those accesses. The pure half of `holdsPhisSiteAccess`,
 * for a caller that already read the snapshot (the Site viewer) and must not read it twice.
 */
export function phisSiteAccessHeldBy(
  role: {
    enabled: boolean;
    roleClaims: readonly PhiViewerRoleClaim[];
    groupClaims: readonly PhiViewerGroupClaim[];
  },
  access: string,
) {
  const policy = (PHIS_SITE_ACCESS_POLICIES as Readonly<Record<string, PhiViewerAccessPolicy>>)[access];
  if (!policy || !role.enabled) {
    return false;
  }
  return canPhiViewerAccess({
    authenticated: true,
    roleClaims: role.roleClaims,
    groupClaims: role.groupClaims,
  }, policy);
}

/**
 * Whether a person holds one of those accesses on a Site. An access the table does not name is no, and
 * so is a disabled membership, exactly as the Site guards treat it.
 */
export async function holdsPhisSiteAccess(siteId: number, userId: number, access: string) {
  if (!(PHIS_SITE_ACCESS_POLICIES as Readonly<Record<string, PhiViewerAccessPolicy>>)[access]) {
    return false;
  }
  return phisSiteAccessHeldBy(await getEffectiveUserSiteAuthorization(userId, siteId), access);
}

/** `phisSiteAccessHeldBy` bound to one snapshot: every access question about that person, answered from it. */
export function phisSiteAccessHolderOf(role: Parameters<typeof phisSiteAccessHeldBy>[0]): PhisSiteAccessHolder {
  return (access) => phisSiteAccessHeldBy(role, access);
}

/**
 * The Site accesses a membership's Core roles admit, for a caller that read the membership rather than the
 * whole snapshot -- user administration, which has every listed person's `enabled` and Core role flags from
 * its own query. Every policy in the table is a Core role mask (`phisSiteAccessCoreRoleFlags`), so the
 * person's groups do not enter and the answer is the one the snapshot gives; Core Admin is admitted to every
 * access by the evaluator, as there.
 */
export function phisSiteAccessHolderOfCoreRoles(membership: { enabled: boolean; coreRoleFlags: number }): PhisSiteAccessHolder {
  return phisSiteAccessHolderOf({
    enabled: membership.enabled,
    roleClaims: membership.coreRoleFlags > 0
      ? [{ providerId: PHI_CORE_ROLE_PROVIDER_ID, flags: membership.coreRoleFlags }]
      : [],
    groupClaims: [],
  });
}

/**
 * Every Site access of one person on one Site, from one read of their authorization snapshot.
 *
 * What a caller asks that has several access questions to put -- whether somebody is Site Admin, whether
 * they meet a grant policy, which Add-on roles a Site access hands them (`impliedBy`) -- so the snapshot is
 * read once rather than once per question.
 */
export async function readPhisSiteAccessHolder(siteId: number, userId: number): Promise<PhisSiteAccessHolder> {
  return phisSiteAccessHolderOf(await getEffectiveUserSiteAuthorization(userId, siteId));
}

/**
 * The Core role flags a Site access admits, for a filter that has to ask it in SQL (the user list's
 * `addonRole`). Every policy in the table is a Core role mask; one that were not could not be put as a
 * mask, and is an error here rather than a filter that silently leaves its holders out. Core Admin is not
 * in the mask, as in the policies: the evaluator admits an Admin to every access, and so must the caller.
 */
export function phisSiteAccessCoreRoleFlags(access: PhisSiteAccess): number {
  const policy: PhiViewerAccessPolicy = PHIS_SITE_ACCESS_POLICIES[access];
  if (policy.access !== "roles" || policy.providerId !== PHI_CORE_ROLE_PROVIDER_ID) {
    throw new Error(`The Site access "${access}" is not a Core role mask.`);
  }
  return policy.allowedRoleFlags;
}

/**
 * Whether a person holds the Site role Admin or Accountant (`PHI_ACCESS_BILLING`): who reads every billing
 * document of the Site and what its payments settled. Not a Site access an Add-on may name; Core asks it
 * for the acting user itself.
 */
export async function holdsPhisBillingRole(siteId: number, userId: number) {
  const role = await getEffectiveUserSiteAuthorization(userId, siteId);
  return role.enabled && canPhiViewerAccess({ authenticated: true, roleClaims: role.roleClaims, groupClaims: role.groupClaims }, PHI_ACCESS_BILLING);
}
