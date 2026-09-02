import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyPhiServerAddonSchema,
  dropPhiServerAddonSchema,
  verifyPhiServerAddonSchema,
} from "./server-addon-schema.mts";
import { getPhiServerConfigSync } from "@/lib/config";
import { quotePhiIdentifier } from "@/lib/addons/schema-ddl";
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
import { buildPhiServerAddonCapabilities } from "@/lib/addons/capabilities";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import type { PhiServerAddonManifestV1 } from "@/lib/addons/contract";

/**
 * The two scopes that carry authority rather than a boundary.
 *
 * What only PostgreSQL can answer: whether a deleted user really leaves the row behind instead of
 * taking it along, and whether the composite group key really refuses a group from another Site. The
 * group id alone would have accepted it, and nothing in the Add-on would have noticed.
 */

const SCHEMA = "phis_addon_pgtest_listings";
const target = {
  schemaName: SCHEMA,
  descriptor: {
    descriptorVersion: 1 as const,
    version: 1,
    tables: [
      {
        name: "listing",
        siteScoped: true,
        groupScoped: true,
        ownerScoped: true,
        columns: [
          { name: "id", type: "identity" as const },
          { name: "title", type: "string" as const, maxLength: 200 },
        ],
        primaryKey: ["id"],
      },
    ],
  },
};

/** Just enough manifest for the capability to derive a schema name and find the table. */
const manifest = {
  manifestVersion: 1,
  addonId: "@pgtest/listings",
  packageName: "@pgtest/listings-server",
  packageVersion: "0.1.0",
  serverAbi: "1",
  capabilities: [],
  serviceProviders: [],
  requiredCoreCapabilities: [
    "@phis/server/authorization:v1",
    "@phis/server/data:v1",
  ],
  apiRoutes: [],
  hooks: [],
  jobs: [],
  settings: [],
  schema: target.descriptor,
  queries: {
    parameters: {
      mine: [],
      add: [{ name: "title", type: "text" }, { name: "group_id", type: "integer" }],
      rename: [{ name: "id", type: "bigInteger" }, { name: "title", type: "text" }],
      drop: [{ name: "id", type: "bigInteger" }],
    },
    queries: [
      {
        kind: "select",
        name: "mine",
        table: "listing",
        where: { kind: "compare", column: "owner_user_id", operator: "=", value: { kind: "actor" } },
        limit: 20,
      },
      {
        kind: "insert",
        name: "add",
        table: "listing",
        values: [{ column: "title", value: { kind: "parameter", name: "title" } }],
        groupParameter: "group_id",
      },
      {
        kind: "update",
        name: "rename",
        table: "listing",
        set: [{ column: "title", value: { kind: "parameter", name: "title" } }],
        idParameter: "id",
      },
      { kind: "delete", name: "drop", table: "listing", idParameter: "id" },
    ],
  },
  migrationVersion: 1,
} as unknown as PhiServerAddonManifestV1;

let migrationPool: Pool;

describe("owner-scoped and group-scoped Add-on tables", () => {
  let site: PhiTestSite;
  let groupId: number;
  let foreignGroupId: number;
  let userId: number;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-scopes");
    const otherSite = await createPhiTestSite("addon-scopes-other");
    groupId = await createPhiTestGroup(site, "vendors");
    foreignGroupId = await createPhiTestGroup(otherSite, "vendors");
    userId = await createPhiTestUser(site);

    const config = getPhiServerConfigSync().database;
    if (!config?.migrationUri || !config.uri) {
      throw new Error("These tests need database.migrationUri and database.uri.");
    }
    const servingRole = decodeURIComponent(new URL(config.uri).username);
    migrationPool = new Pool({ connectionString: config.migrationUri });
    const client = await migrationPool.connect();
    try {
      await dropPhiServerAddonSchema(client, SCHEMA);
      await applyPhiServerAddonSchema(client, target, servingRole);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (migrationPool) {
      const client = await migrationPool.connect();
      try {
        await dropPhiServerAddonSchema(client, SCHEMA);
      } finally {
        client.release();
      }
      await migrationPool.end();
    }
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function insertListing(group: number, owner: number | null) {
    const pool = await requirePhiTestDatabase();
    return pool.query(
      `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."listing"
         (site_id, group_id, owner_user_id, title)
       VALUES ($1, $2, $3, 'a listing')`,
      [site.id, group, owner],
    );
  }

  it("passes its own verification, and notices when a binding is gone", async () => {
    const client = await migrationPool.connect();
    try {
      expect(await verifyPhiServerAddonSchema(client, target)).toEqual([]);
      await client.query(
        `ALTER TABLE ${quotePhiIdentifier(SCHEMA)}."listing" DROP CONSTRAINT "listing_owner_user_id_fk"`,
      );
      expect((await verifyPhiServerAddonSchema(client, target)).join("\n")).toMatch(
        /Owner-scoped table "listing" is not bound/,
      );
      await client.query(
        `ALTER TABLE ${quotePhiIdentifier(SCHEMA)}."listing" ADD CONSTRAINT "listing_owner_user_id_fk" ` +
        `FOREIGN KEY ("owner_user_id") REFERENCES phis.user_accounts(id) ON DELETE SET NULL`,
      );
    } finally {
      client.release();
    }
  });

  it("refuses a group that belongs to another Site", async () => {
    await expect(insertListing(foreignGroupId, userId)).rejects.toThrow(/violates foreign key/i);
  });

  /*
   * The capability, against real rows. Core wrote `owner_user_id` and `group_id`, so Core reads them
   * back and applies the ladder itself -- the Add-on names a row and an intent and never reproduces
   * the rule. What only PostgreSQL can confirm is that the row the capability reads is the row the
   * Add-on meant, in its own schema and its own Site.
   */
  describe("the authorization capability over an Add-on's own rows", () => {
    async function capabilityFor(actorUserId: number | null) {
      const capabilities = buildPhiServerAddonCapabilities({
        manifest,
        manifestDigest: "pgtest-scopes",
        siteId: site.id,
        actorUserId,
      });
      return capabilities.authorization!;
    }

    async function memberAt(level: number) {
      const id = await createPhiTestUser(site);
      await addPhiTestGroupMember({ site, groupId, userId: id, membershipFlags: level });
      return id;
    }

    async function listingOwnedBy(owner: number | null) {
      const pool = await requirePhiTestDatabase();
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."listing"
           (site_id, group_id, owner_user_id, title)
         VALUES ($1, $2, $3, 'a listing') RETURNING id`,
        [site.id, groupId, owner],
      );
      return Number(rows[0]!.id);
    }

    it("is present only when the manifest asked for it", () => {
      const without = buildPhiServerAddonCapabilities({
        manifest: { ...manifest, requiredCoreCapabilities: [] },
        manifestDigest: "pgtest-scopes-none",
        siteId: site.id,
        actorUserId: 1,
      });
      expect(without.authorization).toBeUndefined();
    });

    it("applies the ladder to a row it reads itself", async () => {
      const author = await memberAt(PhiGroupMembershipFlags.Author);
      const editor = await memberAt(PhiGroupMembershipFlags.Editor);
      const manager = await memberAt(PhiGroupMembershipFlags.Manager);
      const mine = await listingOwnedBy(author);

      const asAuthor = await capabilityFor(author);
      expect(await asAuthor.mayActOnRow({ table: "listing", id: mine, intent: "update" })).toBe(true);
      expect(await asAuthor.mayActOnRow({ table: "listing", id: mine, intent: "delete" })).toBe(true);

      const theirs = await listingOwnedBy(editor);
      expect(await asAuthor.mayActOnRow({ table: "listing", id: theirs, intent: "read" })).toBe(true);
      expect(await asAuthor.mayActOnRow({ table: "listing", id: theirs, intent: "update" })).toBe(false);

      const asEditor = await capabilityFor(editor);
      expect(await asEditor.mayActOnRow({ table: "listing", id: mine, intent: "update" })).toBe(true);
      expect(await asEditor.mayActOnRow({ table: "listing", id: mine, intent: "delete" })).toBe(false);

      const asManager = await capabilityFor(manager);
      expect(await asManager.mayActOnRow({ table: "listing", id: mine, intent: "delete" })).toBe(true);
    });

    it("treats an unowned row as nobody's", async () => {
      const author = await memberAt(PhiGroupMembershipFlags.Author);
      const editor = await memberAt(PhiGroupMembershipFlags.Editor);
      const orphan = await listingOwnedBy(null);
      expect(await (await capabilityFor(author)).mayActOnRow({
        table: "listing", id: orphan, intent: "update",
      })).toBe(false);
      expect(await (await capabilityFor(editor)).mayActOnRow({
        table: "listing", id: orphan, intent: "update",
      })).toBe(true);
    });

    it("answers no rather than raising for a row, table, or actor that is not there", async () => {
      const editor = await memberAt(PhiGroupMembershipFlags.Editor);
      const capability = await capabilityFor(editor);
      expect(await capability.mayActOnRow({ table: "listing", id: 999_999, intent: "read" })).toBe(false);
      expect(await capability.mayActOnRow({ table: "invented", id: 1, intent: "read" })).toBe(false);
      const anonymous = await capabilityFor(null);
      expect(await anonymous.mayActOnRow({ table: "listing", id: 1, intent: "read" })).toBe(false);
    });

    it("names the level rather than handing out the bits", async () => {
      const editor = await memberAt(PhiGroupMembershipFlags.Editor);
      const capability = await capabilityFor(editor);
      expect(await capability.groupLevel(groupId)).toBe("editor");
      expect(await capability.groupLevel(foreignGroupId)).toBeNull();
    });

    it("runs a declared query and substitutes the actor itself", async () => {
      const author = await memberAt(PhiGroupMembershipFlags.Author);
      const other = await memberAt(PhiGroupMembershipFlags.Author);
      await listingOwnedBy(other);
      const data = buildPhiServerAddonCapabilities({
        manifest, manifestDigest: "pgtest-data", siteId: site.id, actorUserId: author,
      }).data!;

      expect((await data.select("mine")).rows).toEqual([]);
      const added = await data.insert("add", { title: "mine", group_id: groupId });
      expect(added).toMatchObject({ title: "mine", owner_user_id: author, group_id: groupId });
      const mine = (await data.select("mine")).rows;
      expect(mine).toHaveLength(1);
      expect(mine[0]!.title).toBe("mine");
    });

    it("refuses a mutation the ladder refuses, without the Add-on having to ask", async () => {
      const author = await memberAt(PhiGroupMembershipFlags.Author);
      const intruder = await memberAt(PhiGroupMembershipFlags.Author);
      const theirs = await listingOwnedBy(author);

      const asIntruder = buildPhiServerAddonCapabilities({
        manifest, manifestDigest: "pgtest-data", siteId: site.id, actorUserId: intruder,
      }).data!;
      expect(await asIntruder.update("rename", { id: theirs, title: "hijacked" })).toBeNull();
      expect(await asIntruder.delete("drop", { id: theirs })).toBeNull();

      const pool = await requirePhiTestDatabase();
      const { rows } = await pool.query(
        `SELECT title FROM ${quotePhiIdentifier(SCHEMA)}."listing" WHERE id = $1`,
        [theirs],
      );
      expect(rows[0]!.title).toBe("a listing");

      const asOwner = buildPhiServerAddonCapabilities({
        manifest, manifestDigest: "pgtest-data", siteId: site.id, actorUserId: author,
      }).data!;
      expect(await asOwner.update("rename", { id: theirs, title: "renamed" }))
        .toMatchObject({ title: "renamed" });
    });

    it("undoes the whole unit of work when the body throws", async () => {
      const author = await memberAt(PhiGroupMembershipFlags.Author);
      const data = buildPhiServerAddonCapabilities({
        manifest, manifestDigest: "pgtest-data", siteId: site.id, actorUserId: author,
      }).data!;
      await expect(data.transaction(async (tx) => {
        await tx.insert("add", { title: "first", group_id: groupId });
        await tx.insert("add", { title: "second", group_id: groupId });
        throw new Error("changed my mind");
      })).rejects.toThrow(/changed my mind/);
      expect((await data.select("mine")).rows).toEqual([]);
    });

    it("writes past the ladder under system authority, which is what a job runs with", async () => {
      const author = await memberAt(PhiGroupMembershipFlags.Author);
      const theirs = await listingOwnedBy(author);

      // A job has no actor: nobody owns anything, so the ladder has nothing to apply. Without the
      // system flag this is the refusal the previous test asserts.
      const asJob = buildPhiServerAddonCapabilities({
        manifest,
        manifestDigest: "pgtest-data",
        siteId: site.id,
        actorUserId: null,
        systemAuthority: true,
      }).data!;
      expect(await asJob.update("rename", { id: theirs, title: "swept" }))
        .toMatchObject({ title: "swept" });

      const asNobody = buildPhiServerAddonCapabilities({
        manifest, manifestDigest: "pgtest-data", siteId: site.id, actorUserId: null,
      }).data!;
      expect(await asNobody.update("rename", { id: theirs, title: "not swept" })).toBeNull();
    });

    it("refuses a query name the manifest never declared", async () => {
      const author = await memberAt(PhiGroupMembershipFlags.Author);
      const data = buildPhiServerAddonCapabilities({
        manifest, manifestDigest: "pgtest-data", siteId: site.id, actorUserId: author,
      }).data!;
      await expect(data.select("invented")).rejects.toThrow(/No declared query named/);
      await expect(data.select("add")).rejects.toThrow(/is a insert, not a select/);
    });

    it("answers no Site access to someone with no role", async () => {
      const member = await memberAt(PhiGroupMembershipFlags.Member);
      const capability = await capabilityFor(member);
      expect(await capability.hasSiteAccess("site-admin")).toBe(false);
    });
  });

  /*
   * The group is the one scope column an insert names, and therefore the one an Add-on could aim
   * outside the actor's standing. The contract has always said Core refuses a group they are not in;
   * this is that sentence, against real membership rows.
   */
  describe("the data capability over an insert that names a group", () => {
    function dataFor(actorUserId: number | null) {
      return buildPhiServerAddonCapabilities({
        manifest,
        manifestDigest: "pgtest-scopes-data",
        siteId: site.id,
        actorUserId,
      }).data!;
    }

    async function memberOfTheGroup() {
      const id = await createPhiTestUser(site);
      await addPhiTestGroupMember({
        site,
        groupId,
        userId: id,
        membershipFlags: PhiGroupMembershipFlags.Member,
      });
      return id;
    }

    it("inserts for somebody who stands in the named group", async () => {
      const row = await dataFor(await memberOfTheGroup())
        .insert("add", { title: "in my group", group_id: groupId });
      expect(row).not.toBeNull();
    });

    it("refuses a group the actor does not stand in", async () => {
      const outsider = await createPhiTestUser(site);
      await expect(dataFor(outsider).insert("add", { title: "not mine", group_id: groupId }))
        .rejects.toThrow(/does not stand in/);
    });

    it("refuses another Site's group before the database is asked", async () => {
      // This used to reach PostgreSQL and fail on the composite foreign key, which is the right answer
      // arrived at by accident. The refusal now happens where the reason is, and says what it is.
      await expect(
        dataFor(await memberOfTheGroup()).insert("add", { title: "elsewhere", group_id: foreignGroupId }),
      ).rejects.toThrow(/does not stand in/);
    });

    it("refuses when nobody is acting", async () => {
      await expect(dataFor(null).insert("add", { title: "nobody", group_id: groupId }))
        .rejects.toThrow(/does not stand in/);
    });
  });


  /*
   * A hook reaches the same tables with nobody behind it. Reading is the point -- a public listing is
   * why the Site is stated at all -- and writing is what must not follow from it.
   */
  describe("the data capability with no actor behind the request", () => {
    function dataFor(input: { unauthenticated?: boolean; systemAuthority?: boolean }) {
      return buildPhiServerAddonCapabilities({
        manifest,
        manifestDigest: "pgtest-scopes-anon",
        siteId: site.id,
        actorUserId: null,
        ...input,
      }).data!;
    }

    it("reads", async () => {
      expect((await dataFor({ unauthenticated: true }).select("mine")).rows).toEqual([]);
    });

    it("refuses an insert, which the ladder would not have caught", async () => {
      await expect(dataFor({ unauthenticated: true }).insert("add", { title: "x", group_id: groupId }))
        .rejects.toThrow(/no actor behind it/);
    });

    it("refuses an update and a delete, which the ladder catches anyway", async () => {
      await expect(dataFor({ unauthenticated: true }).update("rename", { id: 1, title: "x" }))
        .rejects.toThrow(/no actor behind it/);
      await expect(dataFor({ unauthenticated: true }).delete("drop", { id: 1 }))
        .rejects.toThrow(/no actor behind it/);
    });

    it("leaves a job alone, which has no actor either but does have authority", async () => {
      const row = await dataFor({ unauthenticated: true, systemAuthority: true })
        .insert("add", { title: "written by a job", group_id: groupId });
      expect(row).not.toBeNull();
    });

    it("does not catch an operator, whose user id is null without them being anonymous", async () => {
      /*
       * The operator is refused too, but by the group rule and not by this one -- they stand in no
       * group, and a group-scoped insert asks for one. Which rule answers is the whole point: the
       * anonymous rule must not be what silences an identified caller.
       */
      await expect(dataFor({}).insert("add", { title: "by an operator", group_id: groupId }))
        .rejects.toThrow(/does not stand in/);
    });
  });


  it("keeps the row when its owner is deleted, and leaves it owned by nobody", async () => {
    const pool = await requirePhiTestDatabase();
    const { rows: inserted } = await pool.query<{ id: string }>(
      `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."listing"
         (site_id, group_id, owner_user_id, title)
       VALUES ($1, $2, $3, 'a listing') RETURNING id`,
      [site.id, groupId, userId],
    );
    const id = inserted[0]!.id;
    await pool.query(`DELETE FROM phis.user_accounts WHERE id = $1`, [userId]);
    const { rows } = await pool.query(
      `SELECT owner_user_id FROM ${quotePhiIdentifier(SCHEMA)}."listing" WHERE id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_user_id).toBeNull();
  });

  it("takes the row with its group", async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.site_groups WHERE id = $1`, [groupId]);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total FROM ${quotePhiIdentifier(SCHEMA)}."listing"`,
    );
    expect(rows[0].total).toBe(0);
  });
});
