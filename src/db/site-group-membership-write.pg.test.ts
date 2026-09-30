import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import {
  addPhiTestGroupMember,
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { removeLocalSiteGroupMembership, setLocalSiteGroupMembership } from "./site-groups";

/**
 * What a membership write answers with.
 *
 * The caller may be the Manager of the one group being written, so the answer names that group and
 * nothing else: the person's other groups, and their levels there, are none of that Manager's business.
 */
describe("a membership write", () => {
  let site: PhiTestSite;
  let managed: number;
  let elsewhere: number;
  let person: number;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("group-membership-write");
    managed = await createPhiTestGroup(site, "managed");
    elsewhere = await createPhiTestGroup(site, "elsewhere");
    person = await createPhiTestUser(site);
    await addPhiTestGroupMember({
      site, groupId: elsewhere, userId: person, membershipFlags: PhiGroupMembershipFlags.Manager,
    });
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("answers with the level in the written group alone", async () => {
    const written = await setLocalSiteGroupMembership({
      siteId: site.id, groupId: managed, userId: person, membershipFlags: PhiGroupMembershipFlags.Author,
    });
    expect(written).toEqual({
      groupId: managed, userId: person, membershipFlags: PhiGroupMembershipFlags.Author,
    });
  });

  it("answers a removal with no level left in that group", async () => {
    const removed = await removeLocalSiteGroupMembership({ siteId: site.id, groupId: managed, userId: person });
    expect(removed).toEqual({ groupId: managed, userId: person, membershipFlags: 0 });
  });
});
