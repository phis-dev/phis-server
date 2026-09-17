export const PHI_CORE_GROUP_PROVIDER_ID = "@phis/server/core" as const;

export {
  PhiGroupMembershipFlags,
  PHI_GROUP_MEMBERSHIP_LEVELS,
  readPhiGroupMembershipLevel,
  type PhiGroupMembershipFlagValue,
} from "@phis/contracts/site-groups";
import { PhiGroupMembershipFlags } from "@phis/contracts/site-groups";
import type { PhisGroupLevel } from "@phis/contracts/addon";

/**
 * The ladder by name, which is how it crosses the Add-on boundary.
 *
 * An Add-on has no reason to know the bits, and a level that travels as a number is one an Add-on ends
 * up doing arithmetic on. Highest first, so a lookup by flags takes the first match.
 */
export const PHI_GROUP_LEVEL_FLAGS: ReadonlyArray<readonly [PhisGroupLevel, number]> = [
  ["manager", PhiGroupMembershipFlags.Manager],
  ["editor", PhiGroupMembershipFlags.Editor],
  ["author", PhiGroupMembershipFlags.Author],
  ["member", PhiGroupMembershipFlags.Member],
];

export function phiGroupLevelFlags(level: PhisGroupLevel) {
  return PHI_GROUP_LEVEL_FLAGS.find(([name]) => name === level)?.[1] ?? null;
}

export function phiGroupLevelOf(flags: number): PhisGroupLevel | null {
  return PHI_GROUP_LEVEL_FLAGS.find(([, value]) => (flags & value) === value)?.[0] ?? null;
}

/**
 * What a group shows, and what it is used for -- never what anyone may do.
 *
 * Authority lives in the membership level, and putting a right here would mean two places decide the
 * same question. `ShowMemberCompany` is a Manager's to set: they know whether their group is one team
 * or people from several companies working together.
 *
 * The two thread bits are not a person's right either; they switch a surface on for the whole group,
 * the way a Media Space kind is available or not, and what anybody may then do there is still their
 * level's answer. They exist because a group is also an audience: five thousand customers grouped for
 * Page access must not become a chat room because the Site offers group threads. Creating groups is
 * Site administration, so these are Developer's and Admin's -- and an Add-on's for the groups it owns,
 * which is how customers in an Add-on's group come to talk to each other without the Site acting.
 */
export const PhiSiteGroupFlags = {
  /** Show each member's company to the other members. Off by default: the least is disclosed first. */
  ShowMemberCompany: 1 << 0,
  /** Members may hold group threads here. */
  Threads: 1 << 1,
  /** This group may address, and be addressed by, other groups. */
  CrossGroupThreads: 1 << 2,
} as const;

export function normalizePhiSiteGroupFlags(value: unknown) {
  const known =
    PhiSiteGroupFlags.ShowMemberCompany
    | PhiSiteGroupFlags.Threads
    | PhiSiteGroupFlags.CrossGroupThreads;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value & known : 0;
}

export function normalizePhiGroupMembershipFlags(value: number) {
  if (!Number.isInteger(value) || value <= 0 || value > PhiGroupMembershipFlags.Manager) {
    throw new Error(
      "Group membership flags must be a cumulative Member, Author, Editor, or Manager value.",
    );
  }
  if ((value & 8) !== 0) return PhiGroupMembershipFlags.Manager;
  if ((value & 4) !== 0) return PhiGroupMembershipFlags.Editor;
  if ((value & 2) !== 0) return PhiGroupMembershipFlags.Author;
  return PhiGroupMembershipFlags.Member;
}
