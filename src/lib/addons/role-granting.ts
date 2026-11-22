import "server-only";

import type { PhisAddonRoleDescriptor, PhisAddonRoleGrantPolicy } from "./contract.ts";
import { PHIS_SITE_ACCESS } from "./contract.ts";
import { listPhiCountingAddonDeclaredRoles } from "./viewer-roles.ts";
import { readPhisAddonHeldRoles } from "./held-roles.ts";
import { readPhisSiteAccessHolder } from "./site-access.ts";

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
  // One read of the actor's authorization answers the floor, a Site-access policy and the roles a Site
  // access implies alike.
  const holdsSiteAccess = await readPhisSiteAccessHolder(input.siteId, input.actorUserId);
  if (holdsSiteAccess(PHIS_SITE_ACCESS.siteAdmin)) {
    return true;
  }
  if ("siteAccess" in input.policy) {
    return holdsSiteAccess(input.policy.siteAccess);
  }
  // Held, not stored: whoever may grant `clerk` because they hold it may also when they hold the
  // `manager` that includes it, or the Site access `clerk` is implied by.
  return (await readPhisAddonHeldRoles({
    addonId: input.addonId,
    siteId: input.siteId,
    userId: input.actorUserId,
    declared: input.declared,
    holdsSiteAccess,
  })).includes(input.policy.role);
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
 * Every role of every Add-on that counts here (`listPhiCountingAddonDeclaredRoles`: enabled and available),
 * and for each whether this person may hand it out.
 *
 * What user administration renders. One screen serves an operator and a `market-admin` alike: it lists
 * what exists and marks what the viewer could grant, and the same evaluation decides the write. A role of an
 * Add-on outside that set guards nothing here, so it is neither offered nor written.
 */
export async function readPhisAddonRoleCatalog(input: {
  siteId: number;
  actorUserId: number;
  /** The snapshot's available providers, read once by the caller (`readAvailablePhisProviderIds`). */
  availableProviderIds: ReadonlySet<string>;
}): Promise<PhisAddonRoleCatalogEntry[]> {
  const catalog: PhisAddonRoleCatalogEntry[] = [];
  /*
   * The same decision `mayGrantPhisAddonRole` makes, asked of the database once per question rather
   * than once per role: the Site Admin floor, every Site-access policy and every `impliedBy` are answered
   * from one read of the person's authorization, and the roles they hold in an Add-on are one read per
   * Add-on. User administration asks this for every Add-on's every role on every visit.
   */
  const holdsSiteAccess = await readPhisSiteAccessHolder(input.siteId, input.actorUserId);
  const siteAdmin = holdsSiteAccess(PHIS_SITE_ACCESS.siteAdmin);
  for (const [addonId, declared] of listPhiCountingAddonDeclaredRoles(input.availableProviderIds)) {
    if (declared.length === 0) {
      continue;
    }
    const held = siteAdmin
      ? null
      : await readPhisAddonHeldRoles({ addonId, siteId: input.siteId, userId: input.actorUserId, declared, holdsSiteAccess });
    const roles: PhisAddonRoleCatalogEntry["roles"] = [];
    for (const role of declared) {
      const policy = role.grantableBy;
      const grantable = siteAdmin
        || ("siteAccess" in policy ? holdsSiteAccess(policy.siteAccess) : (held ?? []).includes(policy.role));
      roles.push({
        name: role.name,
        ...(role.description === undefined ? {} : { description: role.description }),
        grantableBy: policy,
        ...(role.includes === undefined ? {} : { includes: [...role.includes] }),
        grantable,
      });
    }
    catalog.push({ addonId, title: addonId, roles });
  }
  return catalog;
}
