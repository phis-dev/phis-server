import "server-only";

import type { PhisAddonRoleDescriptor, PhisRolesCapabilityV1 } from "./contract.ts";
import { readPhisAddonUserRoles } from "@/db/server-addon-roles.mts";
import { getPool } from "@/lib/db";

/**
 * Whether the acting user holds one of this Add-on's own roles.
 *
 * The declared roles are the shape of the answer, not the stored rows: a grant naming something this
 * release no longer declares is not handed over, the same bargain `settings:v1` strikes with a stored key
 * nobody declared. An Add-on therefore reads exactly the vocabulary it shipped with, whatever has
 * accumulated across versions.
 *
 * There is no writer here, for the reason `settings:v1` and `secrets:v1` have none: an Add-on able to
 * grant its own roles could grant itself whatever those roles guard. Granting goes through Core, which
 * evaluates the `grantableBy` the manifest declared.
 *
 * Nobody acting answers no rather than being absent -- one shape for the Add-on to handle, and "no" is
 * the safe answer when there is no one to ask about.
 */
export function buildPhisAddonRolesCapability(input: {
  addonId: string;
  siteId: number;
  actorUserId: number | null;
  declared: readonly PhisAddonRoleDescriptor[];
}): PhisRolesCapabilityV1 {
  const { addonId, siteId, actorUserId, declared } = input;
  const declaredNames = declared.map((role) => role.name);

  async function held() {
    if (actorUserId == null) {
      return [] as string[];
    }
    const stored = new Set(
      await readPhisAddonUserRoles(getPool(), { addonId, siteId, userId: actorUserId }),
    );
    // Declaration order, not storage order: what the Add-on listed is what it reads back.
    return declaredNames.filter((name) => stored.has(name));
  }

  return Object.freeze({
    async has(role) {
      if (actorUserId == null || !declaredNames.includes(role)) {
        // A role the manifest never declared is no rather than an error: the Add-on asking for one has a
        // bug in its manifest, not in this call.
        return false;
      }
      return (await held()).includes(role);
    },

    async all() {
      return Object.freeze(await held());
    },
  } satisfies PhisRolesCapabilityV1);
}
