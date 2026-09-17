import "server-only";

import type { PhisAddonRoleDescriptor, PhisAddonRoleGrantPolicy } from "./contract.ts";
import { PHIS_SITE_ACCESS } from "./contract.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { readPhisAddonUserRoles } from "@/db/server-addon-roles.mts";
import { getPool } from "@/lib/db";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import { isPhisAddonEnabledForSite } from "@/db/server-addons";
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
  [PHIS_SITE_ACCESS.siteAdmin]: PHI_ACCESS_SITE_ADMIN,
  [PHIS_SITE_ACCESS.developerTools]: PHI_ACCESS_DEVELOPER_TOOLS,
  [PHIS_SITE_ACCESS.structureAuthoring]: PHI_ACCESS_STRUCTURE_AUTHORING,
  [PHIS_SITE_ACCESS.contentEditing]: PHI_ACCESS_CONTENT_EDITING,
  [PHIS_SITE_ACCESS.publishing]: PHI_ACCESS_PUBLISHING,
  [PHIS_SITE_ACCESS.siteMedia]: PHI_ACCESS_SITE_MEDIA,
  [PHIS_SITE_ACCESS.support]: PHI_ACCESS_SUPPORT,
  [PHIS_SITE_ACCESS.accounting]: PHI_ACCESS_ACCOUNTING,
};

export type PhisAddonRoleGrantVerdict =
  | { allowed: true; descriptor: PhisAddonRoleDescriptor }
  | { allowed: false; reason: "addon_unknown" | "role_undeclared" | "not_permitted" };

/**
 * The roles an Add-on declares, or null when it is not installed or not enabled on this Site.
 *
 * A role of an Add-on the Site does not run guards nothing here, and handing it out would leave a grant
 * that silently starts to count the day somebody enables the Add-on.
 */
export async function readPhisAddonDeclaredRoles(addonId: string, siteId: number) {
  const entry = getPhisAddonInstalledManifest()[addonId];
  if (!entry || !await isPhisAddonEnabledForSite(addonId, siteId)) {
    return null;
  }
  return entry.manifest.roles ?? [];
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
 * Whether one person meets a policy an Add-on's manifest states.
 *
 * Shared by the two things a manifest hands out under one -- a role, and the right to make a group --
 * so that "who may cause this" is decided once and reads the same way in both. The Site Admin floor is
 * part of it: without one, a badly declared condition locks a Site out with no way back but a database
 * edit.
 */
export async function satisfiesPhisAddonGrantPolicy(input: {
  addonId: string;
  siteId: number;
  actorUserId: number;
  policy: PhisAddonRoleGrantPolicy;
}) {
  if (await holdsSiteAccess(input.siteId, input.actorUserId, PHIS_SITE_ACCESS.siteAdmin)) {
    return true;
  }
  if ("siteAccess" in input.policy) {
    return await holdsSiteAccess(input.siteId, input.actorUserId, input.policy.siteAccess);
  }
  const held = await readPhisAddonUserRoles(getPool(), {
    addonId: input.addonId,
    siteId: input.siteId,
    userId: input.actorUserId,
  });
  return held.includes(input.policy.role);
}

/**
 * The declared roles are passed in rather than looked up here.
 *
 * The lookup reaches installed state on disk, and a decision function that reaches for global state is
 * one that cannot be exercised without arranging the world first. The caller knows which Add-on it is
 * talking about and has already had to decide the Add-on exists.
 */
export async function mayGrantPhisAddonRole(input: {
  addonId: string;
  siteId: number;
  actorUserId: number;
  role: string;
  declared: readonly PhisAddonRoleDescriptor[] | null;
}): Promise<PhisAddonRoleGrantVerdict> {
  const declared = input.declared;
  if (declared === null) {
    return { allowed: false, reason: "addon_unknown" };
  }
  const descriptor = declared.find((role) => role.name === input.role);
  if (!descriptor) {
    return { allowed: false, reason: "role_undeclared" };
  }

  return await satisfiesPhisAddonGrantPolicy({
    addonId: input.addonId,
    siteId: input.siteId,
    actorUserId: input.actorUserId,
    policy: descriptor.grantableBy,
  })
    ? { allowed: true, descriptor }
    : { allowed: false, reason: "not_permitted" };
}

/**
 * Every role of every Add-on enabled here that this person may hand out.
 *
 * What user administration renders. One screen serves an operator and a `market-admin` alike, because it
 * shows what the viewer could grant and not what exists -- and the same evaluation decides the write.
 */
export async function readPhisAddonGrantableRoles(input: {
  siteId: number;
  actorUserId: number;
}) {
  const installed = getPhisAddonInstalledManifest();
  const grantable: { addonId: string; role: PhisAddonRoleDescriptor }[] = [];
  for (const entry of Object.values(installed)) {
    if (!entry.manifest.roles?.length || !await isPhisAddonEnabledForSite(entry.manifest.addonId, input.siteId)) {
      continue;
    }
    for (const role of entry.manifest.roles) {
      const verdict = await mayGrantPhisAddonRole({
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
