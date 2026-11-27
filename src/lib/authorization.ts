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

export const PHI_ACCESS_SITE_MAINTENANCE = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Maintainer,
} as const satisfies PhiViewerAccessPolicy;

export const PHI_ACCESS_STRUCTURE_AUTHORING = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Maintainer | PhiBaseRole.Builder,
} as const satisfies PhiViewerAccessPolicy;

export const PHI_ACCESS_CONTENT_EDITING = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Maintainer | PhiBaseRole.Author | PhiBaseRole.Publisher,
} as const satisfies PhiViewerAccessPolicy;

export const PHI_ACCESS_PUBLISHING = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Maintainer | PhiBaseRole.Publisher,
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
    PhiBaseRole.Maintainer | PhiBaseRole.Builder | PhiBaseRole.Author | PhiBaseRole.Publisher,
} as const satisfies PhiViewerAccessPolicy;

export const PHI_ACCESS_SUPPORT = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Maintainer | PhiBaseRole.Supporter,
} as const satisfies PhiViewerAccessPolicy;

export const PHI_ACCESS_ACCOUNTING = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Maintainer | PhiBaseRole.Accountant,
} as const satisfies PhiViewerAccessPolicy;

/**
 * The Site's billing documents and settlements (`billing:v1`, `payments:v1` `listSettlements`): the Site
 * roles Admin (through the evaluator) and Accountant, and deliberately not the Site access `accounting`,
 * which also admits a Maintainer (owner, 2026-11-27).
 */
export const PHI_ACCESS_BILLING = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PhiBaseRole.Accountant,
} as const satisfies PhiViewerAccessPolicy;

/**
 * Staff who act on a member's behalf: whoever holds `support` or `accounting` above (Maintainer,
 * Supporter, Accountant, and Admin through the evaluator) -- the two Site accesses `entitlements:v1`
 * `subjectForUser` asks before it names a member to an Add-on. Not a Site access of its own: no Add-on
 * names it, and the Site member picker (`GET /api/site/members`) is what it guards.
 */
export const PHI_ACCESS_ACCOUNTING_OR_SUPPORT = {
  access: "roles",
  providerId: PHI_CORE_ROLE_PROVIDER_ID,
  allowedRoleFlags: PHI_ACCESS_ACCOUNTING.allowedRoleFlags | PHI_ACCESS_SUPPORT.allowedRoleFlags,
} as const satisfies PhiViewerAccessPolicy;
