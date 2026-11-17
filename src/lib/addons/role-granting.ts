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
 * The roles of every Add-on that declares some and is enabled for this Site, by Add-on: the set a save of one
 * person's Add-on roles is the whole state of.
 */
export async function readPhisSiteAddonDeclaredRoles(siteId: number) {
  const declared = new Map<string, readonly PhisAddonRoleDescriptor[]>();
  for (const entry of Object.values(getPhisAddonInstalledManifest())) {
    if (entry.manifest.roles?.length && await isPhisAddonEnabledForSite(entry.manifest.addonId, siteId)) {
      declared.set(entry.manifest.addonId, entry.manifest.roles);
    }
  }
  return declared;
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

export type PhisAddonRoleCatalogEntry = {
  addonId: string;
  /**
   * What the Add-on is called on a screen. The manifest carries no display name, so this is the Add-on
   * id until it does.
   */
  title: string;
  roles: {
    name: string;
    description?: string;
    grantableBy: PhisAddonRoleGrantPolicy;
    includes?: string[];
    /** Whether the acting person may hand this role out -- the decision `mayGrantPhisAddonRole` makes. */
    grantable: boolean;
  }[];
};

/**
 * Every role of every Add-on enabled here, and for each whether this person may hand it out.
 *
 * What user administration renders. One screen serves an operator and a `market-admin` alike: it lists
 * what exists and marks what the viewer could grant, and the same evaluation decides the write.
 */
export async function readPhisAddonRoleCatalog(input: {
  siteId: number;
  actorUserId: number;
}): Promise<PhisAddonRoleCatalogEntry[]> {
  const installed = getPhisAddonInstalledManifest();
  const catalog: PhisAddonRoleCatalogEntry[] = [];
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
    const roles: PhisAddonRoleCatalogEntry["roles"] = [];
    for (const role of entry.manifest.roles) {
      const policy = role.grantableBy;
      const grantable = siteAdmin
        || ("siteAccess" in policy ? await holdsSiteAccess(policy.siteAccess) : (held ?? []).includes(policy.role));
      roles.push({
        name: role.name,
        ...(role.description === undefined ? {} : { description: role.description }),
        grantableBy: policy,
        ...(role.includes === undefined ? {} : { includes: [...role.includes] }),
        grantable,
      });
    }
    catalog.push({ addonId: entry.manifest.addonId, title: entry.manifest.addonId, roles });
  }
  return catalog;
}
