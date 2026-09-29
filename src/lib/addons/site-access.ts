import "server-only";

import { PHIS_SITE_ACCESS, type PhisSiteAccess } from "./contract.ts";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import {
  canPhiViewerAccess,
  PHI_ACCESS_ACCOUNTING,
  PHI_ACCESS_CONTENT_EDITING,
  PHI_ACCESS_DEVELOPER_TOOLS,
  PHI_ACCESS_PUBLISHING,
  PHI_ACCESS_SITE_ADMIN,
  PHI_ACCESS_SITE_MEDIA,
  PHI_ACCESS_STRUCTURE_AUTHORING,
  PHI_ACCESS_SUPPORT,
  type PhiViewerAccessPolicy,
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
  [PHIS_SITE_ACCESS.developerTools]: PHI_ACCESS_DEVELOPER_TOOLS,
  [PHIS_SITE_ACCESS.structureAuthoring]: PHI_ACCESS_STRUCTURE_AUTHORING,
  [PHIS_SITE_ACCESS.contentEditing]: PHI_ACCESS_CONTENT_EDITING,
  [PHIS_SITE_ACCESS.publishing]: PHI_ACCESS_PUBLISHING,
  [PHIS_SITE_ACCESS.siteMedia]: PHI_ACCESS_SITE_MEDIA,
  [PHIS_SITE_ACCESS.support]: PHI_ACCESS_SUPPORT,
  [PHIS_SITE_ACCESS.accounting]: PHI_ACCESS_ACCOUNTING,
};

/**
 * Whether a person holds one of those accesses on a Site. An access the table does not name is no, and
 * so is a disabled membership, exactly as the Site guards treat it.
 */
export async function holdsPhisSiteAccess(siteId: number, userId: number, access: string) {
  const policy = (PHIS_SITE_ACCESS_POLICIES as Readonly<Record<string, PhiViewerAccessPolicy>>)[access];
  if (!policy) {
    return false;
  }
  const role = await getEffectiveUserSiteAuthorization(userId, siteId);
  if (!role.enabled) {
    return false;
  }
  return canPhiViewerAccess({
    authenticated: true,
    roleClaims: role.roleClaims,
    groupClaims: role.groupClaims,
  }, policy);
}
