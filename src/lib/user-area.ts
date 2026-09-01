import "server-only";

import { PhiBaseRole } from "@/lib/constants/phi-base-roles";
import type { PhiResolvedUserArea } from "@/lib/constants/cms-areas";
import { hasPhiFlag } from "@/lib/helpers/flags";

export function resolvePhiUserArea(input: {
  authenticated: boolean;
  roleClaims?: readonly import("@/lib/authorization").PhiViewerRoleClaim[];
}): PhiResolvedUserArea {
  if (!input.authenticated) {
    return "public";
  }

  const coreRoleFlags =
    input.roleClaims?.find(({ providerId }) => providerId === "@phis/server/core")?.flags ?? 0;

  if (hasPhiFlag(coreRoleFlags, PhiBaseRole.Admin)) {
    return "admin";
  }

  if (hasPhiFlag(coreRoleFlags, PhiBaseRole.Developer)) {
    return "admin";
  }

  if (hasPhiFlag(coreRoleFlags, PhiBaseRole.Builder)) {
    return "builder";
  }

  if (hasPhiFlag(coreRoleFlags, PhiBaseRole.Publisher)) {
    return "editor";
  }

  if (hasPhiFlag(coreRoleFlags, PhiBaseRole.Author)) {
    return "editor";
  }

  if (hasPhiFlag(coreRoleFlags, PhiBaseRole.Supporter)) {
    return "app";
  }

  if (hasPhiFlag(coreRoleFlags, PhiBaseRole.Accountant)) {
    return "accounting";
  }

  return "app";
}
