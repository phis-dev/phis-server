import "server-only";

import type { PhiServerAddonRoleDescriptor } from "./contract.ts";
import { PHI_SERVER_SITE_ACCESS } from "./contract.ts";
import { getPhiServerAddonInstalledManifest } from "./installed.ts";
import { readPhiServerAddonUserRoles } from "@/db/server-addon-roles.mts";
import { getPool } from "@/lib/db";
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
 * Whether one person may hand one of an Add-on's roles to another.
 *
 * The policy comes from the manifest, which the digest covers and the running Add-on cannot rewrite. So
 * the author decides who may grant, and Core decides whether the author's condition is met -- which is
 * what keeps "the Add-on defines its own roles" from becoming "the Add-on grants itself anything".
 *
 * A Site Admin may always grant. Without that floor, a badly declared graph locks everyone out with no
 * way back in, and the recovery would be a database edit.
 */

const SITE_ACCESS_POLICIES: Readonly<Record<string, PhiViewerAccessPolicy>> = {
  [PHI_SERVER_SITE_ACCESS.siteAdmin]: PHI_ACCESS_SITE_ADMIN,
  [PHI_SERVER_SITE_ACCESS.developerTools]: PHI_ACCESS_DEVELOPER_TOOLS,
  [PHI_SERVER_SITE_ACCESS.structureAuthoring]: PHI_ACCESS_STRUCTURE_AUTHORING,
  [PHI_SERVER_SITE_ACCESS.contentEditing]: PHI_ACCESS_CONTENT_EDITING,
  [PHI_SERVER_SITE_ACCESS.publishing]: PHI_ACCESS_PUBLISHING,
  [PHI_SERVER_SITE_ACCESS.siteMedia]: PHI_ACCESS_SITE_MEDIA,
  [PHI_SERVER_SITE_ACCESS.support]: PHI_ACCESS_SUPPORT,
  [PHI_SERVER_SITE_ACCESS.accounting]: PHI_ACCESS_ACCOUNTING,
};

export type PhiServerAddonRoleGrantVerdict =
  | { allowed: true; descriptor: PhiServerAddonRoleDescriptor }
  | { allowed: false; reason: "addon_unknown" | "role_undeclared" | "not_permitted" };

/** The roles one installed, Site-enabled Add-on declares, or null when it is not installed here. */
export function readPhiServerAddonDeclaredRoles(addonId: string) {
  const entry = getPhiServerAddonInstalledManifest()[addonId];
  return entry ? entry.manifest.roles ?? [] : null;
}

async function holdsSiteAccess(siteId: number, userId: number, access: string) {
  const policy = SITE_ACCESS_POLICIES[access];
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

/**
 * The declared roles are passed in rather than looked up here.
 *
 * The lookup reaches installed state on disk, and a decision function that reaches for global state is
 * one that cannot be exercised without arranging the world first. The caller knows which Add-on it is
 * talking about and has already had to decide the Add-on exists.
 */
export async function mayGrantPhiServerAddonRole(input: {
  addonId: string;
  siteId: number;
  actorUserId: number;
  role: string;
  declared: readonly PhiServerAddonRoleDescriptor[] | null;
}): Promise<PhiServerAddonRoleGrantVerdict> {
  const declared = input.declared;
  if (declared === null) {
    return { allowed: false, reason: "addon_unknown" };
  }
  const descriptor = declared.find((role) => role.name === input.role);
  if (!descriptor) {
    return { allowed: false, reason: "role_undeclared" };
  }

  // The floor first, because it answers for every role and costs one lookup.
  if (await holdsSiteAccess(input.siteId, input.actorUserId, PHI_SERVER_SITE_ACCESS.siteAdmin)) {
    return { allowed: true, descriptor };
  }

  const policy = descriptor.grantableBy;
  if ("siteAccess" in policy) {
    return (await holdsSiteAccess(input.siteId, input.actorUserId, policy.siteAccess))
      ? { allowed: true, descriptor }
      : { allowed: false, reason: "not_permitted" };
  }

  const held = await readPhiServerAddonUserRoles(getPool(), {
    addonId: input.addonId,
    siteId: input.siteId,
    userId: input.actorUserId,
  });
  return held.includes(policy.role)
    ? { allowed: true, descriptor }
    : { allowed: false, reason: "not_permitted" };
}

/**
 * Every role of every Add-on enabled here that this person may hand out.
 *
 * What user administration renders. One screen serves an operator and a `market-admin` alike, because it
 * shows what the viewer could grant and not what exists -- and the same evaluation decides the write.
 */
export async function readPhiServerAddonGrantableRoles(input: {
  siteId: number;
  actorUserId: number;
}) {
  const installed = getPhiServerAddonInstalledManifest();
  const grantable: { addonId: string; role: PhiServerAddonRoleDescriptor }[] = [];
  for (const entry of Object.values(installed)) {
    for (const role of entry.manifest.roles ?? []) {
      const verdict = await mayGrantPhiServerAddonRole({
        addonId: entry.manifest.addonId,
        siteId: input.siteId,
        actorUserId: input.actorUserId,
        role: role.name,
        declared: entry.manifest.roles ?? [],
      });
      if (verdict.allowed) {
        grantable.push({ addonId: entry.manifest.addonId, role });
      }
    }
  }
  return grantable;
}
