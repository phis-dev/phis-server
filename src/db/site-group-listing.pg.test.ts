import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import {
  addPhiTestGroupMember,
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestSpaceForGroup,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { listGroupMediaSpaces } from "./media-spaces";
import {
  countSiteGroupMembers,
  countSiteGroups,
  listSiteGroupMembers,
  listSiteGroups,
  listSiteGroupsForUser,
} from "./site-groups";

/**
 * A page of groups and a page of members.
 *
 * A Site's groups and a group's members are not bounded by anything, so both lists cut their page in
 * SQL; the count answers the same filter, and "the groups I am in" is that filter narrowed to the
 * actor's claims rather than every group read and sorted out afterwards.
 */
describe("group listing", () => {
  let site: PhiTestSite;
  let groups: number[];
  let person: number;
  const others: number[] = [];

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("group-listing");
    // Names sort as keys do: a, b, c, d, e.
    groups = [];
    for (const key of ["a", "b", "c", "d", "e"]) groups.push(await createPhiTestGroup(site, key));
    person = await createPhiTestUser(site);
    for (const groupId of [groups[1]!, groups[3]!]) {
      await addPhiTestGroupMember({
        site, groupId, userId: person, membershipFlags: PhiGroupMembershipFlags.Member,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      const other = await createPhiTestUser(site);
      others.push(other);
      await addPhiTestGroupMember({
        site, groupId: groups[0]!, userId: other, membershipFlags: PhiGroupMembershipFlags.Member,
      });
    }
    await createPhiTestSpaceForGroup(site, groups[2]!);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("cuts a page of the Site's groups and counts all of them", async () => {
    const page = await listSiteGroups(site.id, { page: { page: 2, pageSize: 2 } });
    expect(page.map((group) => group.key)).toEqual(["c", "d"]);
    expect(await countSiteGroups(site.id)).toBe(5);
    expect(await listSiteGroups(site.id, { page: { page: 4, pageSize: 2 } })).toEqual([]);
  });

  it("narrows to the actor's groups by both halves of the identity", async () => {
    const mine = await listSiteGroupsForUser(site.id, person);
    expect(mine.map((group) => group.key)).toEqual(["b", "d"]);
    const identities = mine.map((group) => ({ providerId: group.providerId, key: group.key }));
    expect(await countSiteGroups(site.id, { identities })).toBe(2);
    // The same key from a provider the actor holds nothing in is not theirs.
    expect(await countSiteGroups(site.id, { identities: [{ providerId: "@phis/other", key: "b" }] })).toBe(0);
    expect(await countSiteGroups(site.id, { identities: [] })).toBe(0);
  });

  it("cuts a page of a group's members and counts all of them", async () => {
    const all = await listSiteGroupMembers(site.id, groups[0]!);
    const page = await listSiteGroupMembers(site.id, groups[0]!, { page: { page: 2, pageSize: 2 } });
    expect(page.map((member) => member.userId)).toEqual([all[2]!.userId]);
    expect(await countSiteGroupMembers(site.id, groups[0]!)).toBe(3);
  });

  it("reads the Spaces of a page of groups at once", async () => {
    const spaces = await listGroupMediaSpaces(site.id, groups);
    expect([...spaces.keys()]).toEqual([groups[2]]);
  });
});
