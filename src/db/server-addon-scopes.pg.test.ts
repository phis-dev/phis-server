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
  requiredCoreCapabilities: ["@phis/phi-server/authorization:v1"],
  apiRoutes: [],
  hooks: [],
  jobs: [],
  schema: target.descriptor,
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

    it("answers no Site access to someone with no role", async () => {
      const member = await memberAt(PhiGroupMembershipFlags.Member);
      const capability = await capabilityFor(member);
      expect(await capability.hasSiteAccess("site-admin")).toBe(false);
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
