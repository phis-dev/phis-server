export const PHI_CORE_GROUP_PROVIDER_ID = "@phis/server/core" as const;

/**
 * The four levels, cumulative and in this order.
 *
 * Each level does everything the one below it does and one thing more, which is what lets a check ask
 * for a level rather than for a list of rights. Read the ladder by what changes at each rung: a Member
 * reads, an Author creates and may edit and delete what they created, an Editor reaches what others
 * created, and a Manager may remove it and administers the group's own membership.
 *
 * Owner-scoped authority is the reason `Author` sits below `Editor` rather than beside it. "May edit
 * only their own" is a narrowing of "may edit", not a different kind of right, so it belongs on the
 * ladder -- and an Editor consequently inherits it. That an Editor may delete their own work while
 * someone else's still needs a Manager follows from the same ordering.
 */
export const PhiGroupMembershipFlags = {
  Member: 1,
  Author: 1 | 2,
  Editor: 1 | 2 | 4,
  Manager: 1 | 2 | 4 | 8,
} as const;

/**
 * What a group's member list shows, not what anyone may do.
 *
 * `site_groups.flags` carries display bits only. Authority lives in the membership level, and putting
 * a right here would mean two places decide the same question. A Manager owns these for their group:
 * they know whether their group is one team or people from several companies working together.
 */
export const PhiSiteGroupFlags = {
  /** Show each member's company to the other members. Off by default: the least is disclosed first. */
  ShowMemberCompany: 1 << 0,
} as const;

export function normalizePhiSiteGroupFlags(value: unknown) {
  const known = PhiSiteGroupFlags.ShowMemberCompany;
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
