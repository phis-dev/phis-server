import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPhiServerAddonGroupsCapability } from "@/lib/addons/groups-capability";
import { buildPhiServerAddonStorageCapability } from "@/lib/addons/storage-capability";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import {
  addPhiTestGroupMember,
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  setPhiTestMediaConfig,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * The two capabilities that touch something outside the process: what an Add-on may learn about a
 * person, and where its bytes go.
 *
 * The disclosure rule is the part worth holding to a test. "An Add-on sees what its actor sees" is easy
 * to state and easy to erode one convenience at a time.
 */

const ADDON_ID = "@pgtest/capabilities";

// One teardown for the file. The test pool is shared, so closing it inside the first suite would pull
// it out from under the second.
afterAll(async () => {
  await dropPhiTestSites();
  await closePhiTestPool();
});

describe("what an Add-on may learn about a person", () => {
  let site: PhiTestSite;
  let groupId: number;
  let otherGroupId: number;
  let actor: number;
  let colleague: number;
  let stranger: number;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-caps");
    groupId = await createPhiTestGroup(site, "vendors");
    otherGroupId = await createPhiTestGroup(site, "elsewhere");
    actor = await createPhiTestUser(site);
    colleague = await createPhiTestUser(site);
    stranger = await createPhiTestUser(site);
    for (const [userId, group] of [[actor, groupId], [colleague, groupId], [stranger, otherGroupId]]) {
      await addPhiTestGroupMember({
        site,
        groupId: group!,
        userId: userId!,
        membershipFlags: PhiGroupMembershipFlags.Member,
      });
    }
  });

  function capability(actorUserId: number | null) {
    return buildPhiServerAddonGroupsCapability({ siteId: site.id, actorUserId });
  }

  it("lists the groups its actor is in, and no others", async () => {
    const groups = await capability(actor).myGroups();
    expect(groups.map((group) => group.key)).toEqual(["vendors"]);
  });

  it("never discloses an address", async () => {
    const members = await capability(actor).members(groupId);
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(member).not.toHaveProperty("email");
      expect(Object.keys(member).sort()).toEqual(["companyName", "displayName", "userId"]);
    }
  });

  it("answers about someone its actor shares a group with", async () => {
    expect(await capability(actor).user(colleague)).toMatchObject({ userId: colleague });
  });

  it("does not turn a row's owner id into a lookup into everybody", async () => {
    expect(await capability(actor).user(stranger)).toBeNull();
    expect(await capability(null).user(colleague)).toBeNull();
  });

  it("says nothing about a group its actor is not in", async () => {
    expect(await capability(actor).members(otherGroupId)).toEqual([]);
  });
});

describe("where an Add-on's bytes go", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-store");
    await setPhiTestMediaConfig(site, { maxObjectBytes: 64 });
  });

  function storage() {
    return buildPhiServerAddonStorageCapability({
      addonId: ADDON_ID,
      siteId: site.id,
      siteKey: site.key,
      readMaxObjectBytes: async () => 64,
    });
  }

  it("round-trips an object under a key the Add-on chose", async () => {
    const store = storage();
    await store.put({
      key: "artifacts/addon.mjs",
      body: new TextEncoder().encode("hello"),
      contentType: "text/javascript",
    });
    const read = await store.get("artifacts/addon.mjs");
    expect(new TextDecoder().decode(read!.body)).toBe("hello");
    expect(read!.contentType).toBe("text/javascript");
    expect(await store.head("artifacts/addon.mjs")).toMatchObject({
      key: "artifacts/addon.mjs",
      byteSize: 5,
    });
    expect(await store.list("artifacts")).toEqual(["artifacts/addon.mjs"]);
  });

  it("answers nothing for an object that is not there, rather than raising", async () => {
    const store = storage();
    expect(await store.get("nothing/here")).toBeNull();
    expect(await store.head("nothing/here")).toBeNull();
    expect(await store.remove("nothing/here")).toBe(false);
  });

  it("removes what it put", async () => {
    const store = storage();
    await store.put({ key: "gone.txt", body: new Uint8Array([1]), contentType: "text/plain" });
    expect(await store.remove("gone.txt")).toBe(true);
    expect(await store.head("gone.txt")).toBeNull();
  });

  it("refuses a key that would climb out of the Add-on's own prefix", async () => {
    const store = storage();
    for (const key of ["../escape", "a/../../b", "/absolute", "", "a//b"]) {
      await expect(store.head(key)).rejects.toThrow(/not a usable object key/);
    }
  });

  it("holds the Site's object ceiling", async () => {
    const store = storage();
    await expect(store.put({
      key: "big.bin",
      body: new Uint8Array(128),
      contentType: "application/octet-stream",
    })).rejects.toThrow(/this Site allows 64/);
  });
});
