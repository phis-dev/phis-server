import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPhiServerAddonGroupsCapability } from "@/lib/addons/groups-capability";
import { buildPhiServerAddonSettingsCapability } from "@/lib/addons/settings-capability";
import { buildPhiServerAddonStorageCapability } from "@/lib/addons/storage-capability";
import { writePhiServerAddonSetting } from "@/db/server-addon-settings.mts";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import {
  addPhiTestGroupMember,
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  activatePhiTestAddonForSite,
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
    return buildPhiServerAddonGroupsCapability({
      addonId: "@pgtest/capabilities",
      siteId: site.id,
      actorUserId,
    });
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

describe("what an operator configured", () => {
  let site: PhiTestSite;
  const declared = [
    { name: "greeting", type: "text" as const, default: "hello" },
    { name: "batch-size", type: "integer" as const, default: 10 },
    { name: "moderated", type: "boolean" as const },
  ];

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-settings");
    await activatePhiTestAddonForSite(site, ADDON_ID);
  });

  function settings() {
    return buildPhiServerAddonSettingsCapability({ addonId: ADDON_ID, siteId: site.id, declared });
  }

  it("answers the declared default until an operator says otherwise", async () => {
    expect(await settings().all()).toEqual({
      greeting: "hello",
      "batch-size": 10,
      // Declared without a default: null is the honest answer, not an invented one.
      moderated: null,
    });
  });

  it("answers what the operator set, and goes back to the default when it is cleared", async () => {
    const pool = await requirePhiTestDatabase();
    await writePhiServerAddonSetting(pool, {
      addonId: ADDON_ID, siteId: site.id, name: "greeting", value: "good day",
    });
    expect(await settings().read("greeting")).toBe("good day");

    await writePhiServerAddonSetting(pool, {
      addonId: ADDON_ID, siteId: site.id, name: "greeting", value: null,
    });
    expect(await settings().read("greeting")).toBe("hello");
  });

  it("ignores a stored key the Add-on no longer declares", async () => {
    const pool = await requirePhiTestDatabase();
    await writePhiServerAddonSetting(pool, {
      addonId: ADDON_ID, siteId: site.id, name: "retired", value: "left over",
    });
    expect(await settings().read("retired")).toBeNull();
    expect(Object.keys(await settings().all()).sort())
      .toEqual(["batch-size", "greeting", "moderated"]);
  });

  it("falls back rather than handing over a value of the wrong type", async () => {
    const pool = await requirePhiTestDatabase();
    // Not reachable through the CLI, which parses first -- but a hand-edited row is, and an Add-on
    // must not be handed a string where it declared an integer.
    await writePhiServerAddonSetting(pool, {
      addonId: ADDON_ID, siteId: site.id, name: "batch-size", value: "many",
    });
    expect(await settings().read("batch-size")).toBe(10);
  });
});

describe("where an Add-on's bytes go", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-store");
    await setPhiTestMediaConfig(site, { maxObjectBytes: 64 });
    // A store belongs to an Add-on that is activated here. Core books every write against that row, and
    // without it there is nothing to charge -- which is a different refusal from a full store.
    await pool.query(
      `INSERT INTO phis.server_addons
         (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
       VALUES ($1, $1, '0.1.0', '1', repeat('0', 64), 'pgtest')
       ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON_ID],
    );
    await pool.query(
      `INSERT INTO phis.site_server_addons (site_id, addon_id) VALUES ($1, $2)
       ON CONFLICT (site_id, addon_id) DO NOTHING`,
      [site.id, ADDON_ID],
    );
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

  it("counts what it holds, so an Add-on can say why a write was refused", async () => {
    const store = storage();
    const before = await store.usage();
    await store.put({ key: "counted.bin", body: new Uint8Array(9), contentType: "text/plain" });
    const after = await store.usage();
    expect(after.bytes - before.bytes).toBe(9);
    expect(after.objects - before.objects).toBe(1);

    // An overwrite is the difference and no new object: an Add-on rewriting one file each hour must not
    // be charged as though it kept every version.
    await store.put({ key: "counted.bin", body: new Uint8Array(4), contentType: "text/plain" });
    const rewritten = await store.usage();
    expect(rewritten.bytes - before.bytes).toBe(4);
    expect(rewritten.objects - before.objects).toBe(1);

    await store.remove("counted.bin");
    expect(await store.usage()).toMatchObject({ bytes: before.bytes, objects: before.objects });
  });

  it("refuses a write past the ceiling, and does not write it", async () => {
    const pool = await requirePhiTestDatabase();
    const store = storage();
    const { bytes } = await store.usage();
    await pool.query(
      `UPDATE phis.site_server_addons SET storage_quota_bytes = $3
        WHERE addon_id = $1 AND site_id = $2`,
      [ADDON_ID, site.id, bytes + 4],
    );

    await expect(store.put({
      key: "over.bin",
      body: new Uint8Array(8),
      contentType: "application/octet-stream",
    })).rejects.toThrow(/store on this Site is full/);
    // Refused before the bytes were written, never after: the object must not be there.
    expect(await store.head("over.bin")).toBeNull();

    await pool.query(
      `UPDATE phis.site_server_addons SET storage_quota_bytes = NULL
        WHERE addon_id = $1 AND site_id = $2`,
      [ADDON_ID, site.id],
    );
  });
});
