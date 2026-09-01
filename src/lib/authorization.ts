/**
 * phi-server's names for the access policies it enforces.
 *
 * The vocabulary itself -- the claim shapes, the policy shapes, and the evaluator -- lives in
 * `@phis/contracts/access`, because the site UI decides the same question in its own process and the two
 * have to agree. They did not, before: a claim with negative flags admitted everything here and nothing
 * there. What stays in this file is only the naming: which policy phi-server means by "Site Admin".
 */

export {
  PHI_CORE_ROLE_PROVIDER_ID,
  PhiBaseRole,
  canPhiAccessSubjectReach as canPhiViewerAccess,
  getPhiViewerRoleFlags,
  hasPhiBaseRole,
  hasProviderAddonRole,
  hasProviderGroup,
  hasProviderRole,
  isPhiAccessPolicyProviderOwned,
  readPhiViewerAccessPolicy,
  type PhiGroupProviderId,
  type PhiRoleProviderId,
  type PhiViewerAccessPolicy,
  type PhiViewerAddonRoleClaim,
  type PhiViewerGroupClaim,
  type PhiViewerRoleClaim,
} from "@phis/contracts/access";

import {
  PHI_CORE_ROLE_PROVIDER_ID,
  PhiBaseRole,
  type PhiViewerAccessPolicy,
} from "@phis/contracts/access";
import type { PhiAccessSubject } from "@phis/contracts/access";

/** phi-server's viewer is the shared subject; the name is kept because the call sites use it. */
export type PhiAuthorizationViewer = PhiAccessSubject;

export const PHI_ACCESS_SITE_ADMIN = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Admin,
} as const satisfies PhiViewerAccessPolicy;

export const PHI_ACCESS_DEVELOPER_TOOLS = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Developer,
} as const satisfies PhiViewerAccessPolicy;

export const PHI_ACCESS_STRUCTURE_AUTHORING = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Developer | PhiBaseRole.Builder,
} as const satisfies PhiViewerAccessPolicy;

export const PHI_ACCESS_CONTENT_EDITING = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Developer | PhiBaseRole.Author | PhiBaseRole.Publisher,
} as const satisfies PhiViewerAccessPolicy;

export const PHI_ACCESS_PUBLISHING = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Developer | PhiBaseRole.Publisher,
} as const satisfies PhiViewerAccessPolicy;

/**
 * Site Space Media management: create, use, update, and unreferenced delete.
 *
 * Supporter and Accountant deliberately receive no Media management authority, and public or
 * authenticated delivery never grants it either. The Core Admin override is applied by the evaluator
 * and is therefore not repeated in the mask.
 */
export const PHI_ACCESS_SITE_MEDIA = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags:
    PhiBaseRole.Developer | PhiBaseRole.Builder | PhiBaseRole.Author | PhiBaseRole.Publisher,
} as const satisfies PhiViewerAccessPolicy;

export const PHI_ACCESS_SUPPORT = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Developer | PhiBaseRole.Supporter,
} as const satisfies PhiViewerAccessPolicy;

export const PHI_ACCESS_ACCOUNTING = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Developer | PhiBaseRole.Accountant,
} as const satisfies PhiViewerAccessPolicy;
