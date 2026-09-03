import "server-only";

import type { PhisGroupsCapabilityV1, PhisUserProjection } from "./contract.ts";
import {
  listSiteGroupMembers,
  listSiteGroupsForUser,
  getSiteGroupById,
  projectSiteGroupMemberForMember,
} from "@/db/site-groups";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import { readPhisAddonSiteGroups } from "@/db/server-addon-groups.mts";
import { getPool } from "@/lib/db";

/**
 * Group facts, bounded by the acting user.
 *
 * Every answer here is one the acting user could already have obtained through the Site's own group
 * routes, projected exactly as those project it. That is the rule in one sentence: **an Add-on sees
 * what its actor sees.** It fixes the disclosure question without a second policy to keep in step, and
 * it means no question here can turn a Site's user table into a directory an Add-on can walk.
 *
 * `projectSiteGroupMemberForMember` is what does the projecting, which is why an address never appears:
 * it sets `email` to null and discloses a company only where the group's own flag says to. That
 * decision belongs to the group's Manager, and an Add-on inherits it rather than being asked.
 */

function project(
  member: Awaited<ReturnType<typeof listSiteGroupMembers>>[number],
  groupFlags: number,
): PhisUserProjection {
  const projected = projectSiteGroupMemberForMember(member, groupFlags);
  return {
    userId: projected.userId,
    displayName: projected.displayName,
    companyName: projected.companyName,
  };
}

export function buildPhisAddonGroupsCapability(input: {
  addonId: string;
  siteId: number;
  actorUserId: number | null;
}): PhisGroupsCapabilityV1 {
  const { addonId, siteId, actorUserId } = input;

  /** The groups the actor is in, which is the boundary every answer below is drawn against. */
  async function actorGroups() {
    return actorUserId == null ? [] : listSiteGroupsForUser(siteId, actorUserId);
  }

  async function memberOf(groupId: number) {
    return (await actorGroups()).some(
      (group) =>
        group.id === groupId &&
        (group.membershipFlags & PhiGroupMembershipFlags.Member) === PhiGroupMembershipFlags.Member,
    );
  }

  return Object.freeze({
    async declared() {
      // Read by provider id, so an Add-on gets its own and nobody else's -- including no Core group,
      // whose ids are not this Add-on's business.
      return readPhisAddonSiteGroups(getPool(), { addonId, siteId });
    },

    async myGroups() {
      return (await actorGroups()).map((group) => ({
        id: group.id,
        key: group.key,
        name: group.name,
      }));
    },

    async members(groupId) {
      if (!await memberOf(groupId)) {
        // Empty rather than an error: "not a group you are in" and "a group with nobody in it" are the
        // same answer to someone who may not know which of the two it is.
        return [];
      }
      const group = await getSiteGroupById(siteId, groupId);
      if (!group) {
        return [];
      }
      const members = await listSiteGroupMembers(siteId, groupId);
      return members.map((member) => project(member, group.flags));
    },

    async user(userId) {
      if (actorUserId == null) {
        return null;
      }
      for (const group of await actorGroups()) {
        const members = await listSiteGroupMembers(siteId, group.id);
        const found = members.find((member) => member.userId === userId);
        if (found) {
          // The first group the two share settles the disclosure. Trying every group and taking the
          // most generous would let a person's company leak out of the one group that discloses it.
          return project(found, group.flags);
        }
      }
      return null;
    },
  } satisfies PhisGroupsCapabilityV1);
}
