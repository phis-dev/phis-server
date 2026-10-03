import "server-only";

import type {
  PhisAddonGroupWriterDescriptor,
  PhisGroupsCapabilityV1,
  PhisUserProjection,
} from "./contract.ts";
import {
  listSiteGroupMembers,
  listSiteGroupsForUser,
  getSiteGroupById,
  projectSiteGroupMemberForMember,
  removeLocalSiteGroupMembership,
  setLocalSiteGroupMembership,
} from "@/db/site-groups";
import {
  PhiGroupMembershipFlags,
  phiGroupLevelFlags,
  phiGroupLevelOf,
} from "@/lib/constants/site-groups";
import {
  createPhisAddonSiteGroup,
  readPhisAddonSiteGroupKey,
  readPhisAddonSiteGroups,
  retirePhisAddonSiteGroup,
} from "@/db/server-addon-groups.mts";
import { isPhiSiteMember } from "@/db/server-addon-owner.mts";
import { satisfiesPhisAddonGrantPolicy } from "./role-granting.ts";
import { getPool } from "@/lib/db";

export class PhisAddonGroupWriteError extends Error {}

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
  /** Absent where the manifest declares no writer, and then every write below is refused. */
  groupWriter?: PhisAddonGroupWriterDescriptor | null;
  /** The keys of the groups the manifest declares, which the writer leaves alone. */
  declaredGroupKeys?: readonly string[];
}): PhisGroupsCapabilityV1 {
  const { addonId, siteId, actorUserId } = input;
  const declaredKeys = new Set(input.declaredGroupKeys ?? []);

  /**
   * Whether this caller may write groups at all.
   *
   * Two conditions and both are the manifest's: that it asked for a writer, and that the acting user
   * meets the policy it stated. Refused loudly, unlike the reads above -- there is nothing to withhold
   * here, and a swallowed write would look to an Add-on exactly like one that happened.
   */
  async function requireWriter() {
    const policy = input.groupWriter?.allowedBy;
    if (!policy) {
      throw new PhisAddonGroupWriteError(
        `${addonId} declares no groupWriter, so it cannot make or administer groups.`,
      );
    }
    if (actorUserId == null) {
      throw new PhisAddonGroupWriteError("A group is made for somebody, and nobody is acting here.");
    }
    if (!await satisfiesPhisAddonGrantPolicy({ addonId, siteId, actorUserId, policy })) {
      throw new PhisAddonGroupWriteError(
        "This caller does not meet the policy the manifest states for making a group.",
      );
    }
  }

  /** The group has to be this Add-on's, checked before every write and never inferred from the id. */
  async function requireOwnGroup(groupId: number) {
    const key = await readPhisAddonSiteGroupKey(getPool(), { addonId, siteId, groupId });
    if (key == null) {
      throw new PhisAddonGroupWriteError(`Group ${groupId} is not ${addonId}'s to administer.`);
    }
    if (declaredKeys.has(key)) {
      /*
       * A group the manifest declares is one the Site always has, filled by its administrators. The
       * writer's policy may be far below theirs, so filling such a group at runtime would be a way past
       * whoever the Site trusted with it.
       */
      throw new PhisAddonGroupWriteError(
        `Group "${key}" is declared in the manifest, so it is the Site's to fill, not the writer's.`,
      );
    }
  }

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
      return (await actorGroups()).flatMap((group) => {
        const level = phiGroupLevelOf(group.membershipFlags);
        // A membership whose bits amount to no level is one this build does not understand, and
        // reporting it without one would invite a caller to treat it as the lowest.
        return level ? [{ id: group.id, key: group.key, name: group.name, level }] : [];
      });
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

    async create({ key, name }) {
      await requireWriter();
      if (declaredKeys.has(key)) {
        // The upsert would rename it and bring it back from retirement, and the writes after would fill it.
        throw new PhisAddonGroupWriteError(
          `"${key}" is a group the manifest declares; the writer makes groups of its own.`,
        );
      }
      const action = await createPhisAddonSiteGroup(getPool(), { addonId, siteId, key, name });
      return { id: action.groupId, key: action.key, name };
    },

    async addMember({ groupId, userId, level }) {
      await requireWriter();
      await requireOwnGroup(groupId);
      if (!await isPhiSiteMember(getPool(), siteId, userId)) {
        // Refused rather than written: a membership for somebody who cannot sign in to this Site grants
        // nothing and would sit there looking like standing.
        throw new PhisAddonGroupWriteError(`User ${userId} is not an active member of this Site.`);
      }
      const membershipFlags = phiGroupLevelFlags(level);
      if (membershipFlags === null) {
        throw new PhisAddonGroupWriteError(`"${String(level)}" is not a membership level.`);
      }
      await setLocalSiteGroupMembership({
        siteId, groupId, userId, membershipFlags, providerId: addonId,
      });
      return true;
    },

    async removeMember({ groupId, userId }) {
      await requireWriter();
      await requireOwnGroup(groupId);
      await removeLocalSiteGroupMembership({ siteId, groupId, userId, providerId: addonId });
      return true;
    },

    async retire({ groupId }) {
      await requireWriter();
      await requireOwnGroup(groupId);
      return await retirePhisAddonSiteGroup(getPool(), { addonId, siteId, groupId });
    },
  } satisfies PhisGroupsCapabilityV1);
}
