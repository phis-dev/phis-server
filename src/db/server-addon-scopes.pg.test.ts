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
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

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

  it("keeps the row when its owner is deleted, and leaves it owned by nobody", async () => {
    const pool = await requirePhiTestDatabase();
    await insertListing(groupId, userId);
    await pool.query(`DELETE FROM phis.user_accounts WHERE id = $1`, [userId]);
    const { rows } = await pool.query(
      `SELECT owner_user_id FROM ${quotePhiIdentifier(SCHEMA)}."listing"`,
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
