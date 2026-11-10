import "server-only";

import type { PhisAddonRoleDescriptor, PhisAddonRoleGrantPolicy } from "./contract.ts";
import { PHIS_SITE_ACCESS } from "./contract.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { expandPhisAddonHeldRoles } from "./role-inclusion.ts";
import { readPhisAddonUserRoles } from "@/db/server-addon-roles.mts";
import { getPool } from "@/lib/db";
import { isPhisAddonEnabledForSite } from "@/db/server-addons";
import { holdsPhisSiteAccess } from "./site-access.ts";

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
  /**
   * The roles the Add-on's manifest declares, from the caller, who holds that manifest. They decide
   * which roles a granted one implies; read here from installed state instead, a caller whose Add-on
   * that state does not know would be refused everything.
   */
  declared: readonly PhisAddonRoleDescriptor[];
}) {
  if (await holdsPhisSiteAccess(input.siteId, input.actorUserId, PHIS_SITE_ACCESS.siteAdmin)) {
    return true;
  }
  if ("siteAccess" in input.policy) {
    return await holdsPhisSiteAccess(input.siteId, input.actorUserId, input.policy.siteAccess);
  }
  const granted = await readPhisAddonUserRoles(getPool(), {
    addonId: input.addonId,
    siteId: input.siteId,
    userId: input.actorUserId,
  });
  // Implied roles count: whoever may grant `clerk` because they hold it may also when they hold the
  // `manager` that includes it.
  return expandPhisAddonHeldRoles(input.declared, granted).includes(input.policy.role);
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
    declared,
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
  /*
   * The same decision `mayGrantPhisAddonRole` makes, asked of the database once per question rather
   * than once per role: the Site Admin floor is one answer for every role, a Site-access policy is one
   * answer per access level, and the roles the person holds in an Add-on are one read per Add-on.
   * User administration asks this for every Add-on's every role on every visit.
   */
  const siteAdmin = await holdsPhisSiteAccess(input.siteId, input.actorUserId, PHIS_SITE_ACCESS.siteAdmin);
  const siteAccessHeld = new Map<string, boolean>();
  const holdsSiteAccess = async (access: Parameters<typeof holdsPhisSiteAccess>[2]) => {
    const key = String(access);
    let held = siteAccessHeld.get(key);
    if (held === undefined) {
      held = await holdsPhisSiteAccess(input.siteId, input.actorUserId, access);
      siteAccessHeld.set(key, held);
    }
    return held;
  };
  for (const entry of Object.values(installed)) {
    if (!entry.manifest.roles?.length || !await isPhisAddonEnabledForSite(entry.manifest.addonId, input.siteId)) {
      continue;
    }
    const held = siteAdmin
      ? null
      : expandPhisAddonHeldRoles(entry.manifest.roles, await readPhisAddonUserRoles(getPool(), {
        addonId: entry.manifest.addonId,
        siteId: input.siteId,
        userId: input.actorUserId,
      }));
    for (const role of entry.manifest.roles) {
      const policy = role.grantableBy;
      const allowed = siteAdmin
        || ("siteAccess" in policy ? await holdsSiteAccess(policy.siteAccess) : (held ?? []).includes(policy.role));
      if (allowed) {
        grantable.push({ addonId: entry.manifest.addonId, role });
      }
    }
  }
  return grantable;
}
