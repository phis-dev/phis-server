export const PHI_CORE_GROUP_PROVIDER_ID = "@phis/phi-server/core" as const;

export const PhiGroupMembershipFlags = {
  Member: 1,
  Contributor: 1 | 2,
  Manager: 1 | 2 | 4,
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
    throw new Error("Group membership flags must be a cumulative Member, Contributor, or Manager value.");
  }
  if ((value & 4) !== 0) return PhiGroupMembershipFlags.Manager;
  if ((value & 2) !== 0) return PhiGroupMembershipFlags.Contributor;
  return PhiGroupMembershipFlags.Member;
}
