import { PhiBaseRole } from "@/lib/constants/phi-base-roles";

export const PHI_CORE_ROLE_PROVIDER_ID = "@phis/phi-server/core" as const;

export type PhiRoleProviderId = `@${string}/${string}`;

export type PhiViewerRoleClaim = {
  providerId: PhiRoleProviderId;
  flags: number;
};

export type PhiGroupProviderId = `@${string}/${string}`;

export type PhiViewerGroupClaim = {
  providerId: PhiGroupProviderId;
  key: string;
  flags: number;
};

export type PhiViewerAccessPolicy =
  | { access: "anyone" }
  | { access: "anonymous" }
  | { access: "authenticated" }
  | {
      access: "roles";
      providerId: PhiRoleProviderId;
      allowedRoleFlags: number;
    }
  | {
      access: "groups";
      providerId: PhiGroupProviderId;
      allowedGroupKeys: readonly string[];
    };

export type PhiAuthorizationViewer = {
  authenticated: boolean;
  roleClaims: readonly PhiViewerRoleClaim[];
  groupClaims: readonly PhiViewerGroupClaim[];
};

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

export function getPhiViewerRoleFlags(
  viewer: Pick<PhiAuthorizationViewer, "roleClaims">,
  providerId: PhiRoleProviderId,
) {
  return viewer.roleClaims.find((claim) => claim.providerId === providerId)?.flags ?? 0;
}

export function hasProviderRole(
  viewer: Pick<PhiAuthorizationViewer, "roleClaims">,
  providerId: PhiRoleProviderId,
  roleFlag: number,
) {
  return roleFlag > 0 && (getPhiViewerRoleFlags(viewer, providerId) & roleFlag) !== 0;
}

export function hasPhiBaseRole(
  viewer: Pick<PhiAuthorizationViewer, "roleClaims">,
  roleFlag: number,
) {
  return hasProviderRole(viewer, PHI_CORE_ROLE_PROVIDER_ID, roleFlag);
}

export function hasProviderGroup(
  viewer: Pick<PhiAuthorizationViewer, "groupClaims">,
  providerId: PhiGroupProviderId,
  groupKey: string,
) {
  return viewer.groupClaims.some((claim) => claim.providerId === providerId && claim.key === groupKey);
}

export function canPhiViewerAccess(
  viewer: PhiAuthorizationViewer,
  policy: PhiViewerAccessPolicy,
) {
  if (policy.access === "anyone") {
    return true;
  }
  if (policy.access === "anonymous") {
    return !viewer.authenticated;
  }
  if (!viewer.authenticated) {
    return false;
  }
  if (policy.access === "authenticated") {
    return true;
  }
  if (hasPhiBaseRole(viewer, PhiBaseRole.Admin)) {
    return true;
  }
  if (policy.access === "groups") {
    return policy.allowedGroupKeys.length > 0 && policy.allowedGroupKeys.some((key) =>
      hasProviderGroup(viewer, policy.providerId, key),
    );
  }
  return policy.allowedRoleFlags > 0 &&
    (getPhiViewerRoleFlags(viewer, policy.providerId) & policy.allowedRoleFlags) !== 0;
}
