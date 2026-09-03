import { describe, expect, it } from "vitest";

import { canWriteSiteGroupMembership } from "@/lib/guards/site-group-api";
import { projectSiteGroupMemberForMember } from "@/db/site-groups";
import {
  PhiGroupMembershipFlags,
  PhiSiteGroupFlags,
  normalizePhiSiteGroupFlags,
} from "@/lib/constants/site-groups";

const MANAGER = { siteWide: false, membershipFlags: PhiGroupMembershipFlags.Manager };
const SITE_WIDE = { siteWide: true, membershipFlags: PhiGroupMembershipFlags.Manager };

/*
 * The levels are cumulative, so a Manager who could set or clear the Manager bit would be granting or
 * revoking their own authority. Both sides are checked: the level being written and the level already
 * on the row, because demoting or removing a Manager is a demotion just as much as never appointing
 * one. It also means a group cannot lose its last Manager from the inside.
 */
describe("canWriteSiteGroupMembership", () => {
  it("lets a Manager set Author and Member", () => {
    for (const next of [PhiGroupMembershipFlags.Member, PhiGroupMembershipFlags.Author]) {
      expect(canWriteSiteGroupMembership(MANAGER, { next, current: PhiGroupMembershipFlags.Member })).toBe(true);
    }
  });

  it("stops a Manager from appointing another Manager", () => {
    expect(canWriteSiteGroupMembership(MANAGER, {
      next: PhiGroupMembershipFlags.Manager,
      current: PhiGroupMembershipFlags.Author,
    })).toBe(false);
  });

  it("stops a Manager from demoting an existing Manager", () => {
    expect(canWriteSiteGroupMembership(MANAGER, {
      next: PhiGroupMembershipFlags.Author,
      current: PhiGroupMembershipFlags.Manager,
    })).toBe(false);
  });

  it("stops a Manager from removing an existing Manager", () => {
    expect(canWriteSiteGroupMembership(MANAGER, { current: PhiGroupMembershipFlags.Manager })).toBe(false);
  });

  it("lets a Manager remove an Author", () => {
    expect(canWriteSiteGroupMembership(MANAGER, { current: PhiGroupMembershipFlags.Author })).toBe(true);
  });

  it("lets Developer and Admin write any level", () => {
    expect(canWriteSiteGroupMembership(SITE_WIDE, {
      next: PhiGroupMembershipFlags.Manager,
      current: PhiGroupMembershipFlags.Manager,
    })).toBe(true);
    expect(canWriteSiteGroupMembership(SITE_WIDE, { current: PhiGroupMembershipFlags.Manager })).toBe(true);
  });
});

describe("what one member sees of another", () => {
  const member = {
    userId: 7,
    displayName: "Codex AI",
    email: "ai@example.com",
    companyName: "Acme",
    membershipFlags: PhiGroupMembershipFlags.Author,
    sourceProviderId: "@phis/server/core",
    sourceConnectionKey: "local",
    validUntil: null,
    createdAt: "2026-08-24T00:00:00.000Z",
  };

  it("never hands a colleague an address", () => {
    expect(projectSiteGroupMemberForMember(member, PhiSiteGroupFlags.ShowMemberCompany).email).toBeNull();
    expect(projectSiteGroupMemberForMember(member, 0).email).toBeNull();
  });

  it("shows the company only when the group says so", () => {
    expect(projectSiteGroupMemberForMember(member, 0).companyName).toBeNull();
    expect(projectSiteGroupMemberForMember(member, PhiSiteGroupFlags.ShowMemberCompany).companyName)
      .toBe("Acme");
  });

  it("keeps the name and the level, which is what the list is for", () => {
    const projected = projectSiteGroupMemberForMember(member, 0);
    expect(projected.displayName).toBe("Codex AI");
    expect(projected.membershipFlags).toBe(PhiGroupMembershipFlags.Author);
  });
});

describe("group display flags", () => {
  it("drops a bit this build does not know", () => {
    expect(normalizePhiSiteGroupFlags(PhiSiteGroupFlags.ShowMemberCompany | (1 << 5)))
      .toBe(PhiSiteGroupFlags.ShowMemberCompany);
  });

  it("treats anything that is not a flag value as none", () => {
    expect(normalizePhiSiteGroupFlags(-1)).toBe(0);
    expect(normalizePhiSiteGroupFlags("1")).toBe(0);
    expect(normalizePhiSiteGroupFlags(undefined)).toBe(0);
  });
});

