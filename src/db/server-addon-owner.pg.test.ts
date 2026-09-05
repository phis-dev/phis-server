import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhisAddonSchema, dropPhisAddonSchema } from "./server-addon-schema.mts";
import { transferPhisAddonOwnership } from "./server-addon-owner.mts";
import { getPhisConfigSync } from "@/lib/config";
import { buildPhisAddonCapabilities } from "@/lib/addons/capabilities";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { PhisAddonManifestV1 } from "@/lib/addons/contract";

/**
 * Handing rows to a successor.
 *
 * A vendor is usually one person, and one day it is somebody else. The row's owner is authority and has
 * to move; who wrote it is history and must not, or the first handover erases the answer to "where did
 * this come from" -- which for a catalogue is half of what a row is worth.
 *
 * The other half of the case is the account that is simply gone. Deleting a user leaves `owner_user_id`
 * null rather than taking the row along, and those rows are exactly the ones a successor is appointed
 * for, so they move too.
 */

const SCHEMA = "phis_addon_pgtest_owner";
const ADDON = "@pgtest/owner";

const schema = {
  descriptorVersion: 1 as const,
  version: 1,
  tables: [
    {
      name: "offering",
      siteScoped: true,
      ownerScoped: true,
      columns: [
        { name: "id", type: "identity" as const },
        { name: "name", type: "string" as const, maxLength: 64 },
      ],
      primaryKey: ["id"],
    },
  ],
};

const manifest = {
  manifestVersion: 1,
  addonId: ADDON,
  packageName: ADDON,
  packageVersion: "0.1.0",
  serverAbi: "1",
  capabilities: [],
  serviceProviders: [],
  requiredCoreCapabilities: ["@phis/server/data:v1"],
  apiRoutes: [],
  hooks: [],
  jobs: [],
  settings: [],
  schema,
  queries: {
    parameters: { add: [{ name: "name", type: "text" }], mine: [] },
    queries: [
      {
        kind: "insert",
        name: "add",
        table: "offering",
        values: [{ column: "name", value: { kind: "parameter", name: "name" } }],
      },
      {
        kind: "select",
        name: "mine",
        table: "offering",
        where: { kind: "compare", column: "owner_user_id", operator: "=", value: { kind: "actor" } },
        orderBy: [{ column: "id", direction: "asc" }],
        limit: 25,
      },
    ],
  },
  migrationVersion: 1,
} as unknown as PhisAddonManifestV1;

let migrationPool: Pool;

describe("handing an Add-on's rows to another account", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;
  let predecessor: number;
  let successor: number;
  let stranger: number;

  function data(actorUserId: number) {
    return buildPhisAddonCapabilities({
      manifest,
      manifestDigest: "pgtest-owner",
      siteId: site.id,
      siteKey: site.key,
      actorUserId,
    }).data!;
  }

  async function ownerOf(id: unknown) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ owner: number | null; author: number | null }>(
      `SELECT owner_user_id AS owner, created_by_user_id AS author
         FROM ${SCHEMA}.offering WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-owner");
    other = await createPhiTestSite("addon-owner-2");
    predecessor = await createPhiTestUser(site);
    successor = await createPhiTestUser(site);
    stranger = await createPhiTestUser(other);

    const config = getPhisConfigSync().database;
    if (!config?.migrationUri || !config.uri) {
      throw new Error("These tests need database.migrationUri and database.uri.");
    }
    const servingRole = decodeURIComponent(new URL(config.uri).username);
    migrationPool = new Pool({ connectionString: config.migrationUri });
    const client = await migrationPool.connect();
    try {
      await dropPhisAddonSchema(client, SCHEMA);
      await applyPhisAddonSchema(client, { schemaName: SCHEMA, descriptor: schema }, servingRole);
    } finally {
      client.release();
    }
    await pool.query(
      `INSERT INTO phis.server_addons
         (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
       VALUES ($1, $1, '0.1.0', '1', repeat('0', 64), 'pgtest')
       ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON],
    );
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    if (migrationPool) {
      const client = await migrationPool.connect();
      try {
        await dropPhisAddonSchema(client, SCHEMA);
      } finally {
        client.release();
      }
      await migrationPool.end();
    }
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await closePhiTestPool();
  });

  it("writes the author beside the owner, from the same actor", async () => {
    const row = await data(predecessor).insert("add", { name: "acme" });
    expect(await ownerOf(row!.id)).toEqual({ owner: predecessor, author: predecessor });
    // And hands both back, because a row that cannot say who wrote it is one an Add-on cannot render.
    expect(row).toMatchObject({ owner_user_id: predecessor, created_by_user_id: predecessor });
  });

  it("moves the owner and leaves the author where it is", async () => {
    const row = await data(predecessor).insert("add", { name: "handed-over" });
    const pool = await requirePhiTestDatabase();

    const result = await transferPhisAddonOwnership(pool, {
      addonId: ADDON, siteId: site.id, fromUserId: predecessor, toUserId: successor,
    });
    expect(result.rows).toBeGreaterThan(0);
    expect(await ownerOf(row!.id)).toEqual({ owner: successor, author: predecessor });

    // And the successor now reaches it as their own, which is the whole point of moving authority.
    const mine = await data(successor).select("mine", {});
    expect(mine.rows.map((entry) => entry.name)).toContain("handed-over");
  });

  it("picks up the rows a deleted account left behind", async () => {
    /*
     * `ON DELETE SET NULL` on the owner is what keeps a row when its author's account goes. Those rows
     * are unreachable through the ladder -- nobody owns them -- so they are exactly the ones a successor
     * is appointed for.
     */
    const row = await data(predecessor).insert("add", { name: "orphaned" });
    const pool = await requirePhiTestDatabase();
    await pool.query(`UPDATE ${SCHEMA}.offering SET owner_user_id = NULL WHERE id = $1`, [row!.id]);

    await transferPhisAddonOwnership(pool, {
      addonId: ADDON, siteId: site.id, fromUserId: null, toUserId: successor,
    });
    expect(await ownerOf(row!.id)).toEqual({ owner: successor, author: predecessor });
  });

  it("leaves another Site's rows alone", async () => {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.offering (site_id, owner_user_id, created_by_user_id, name)
       VALUES ($1, $2, $2, 'elsewhere') RETURNING id`,
      [other.id, stranger],
    );

    await transferPhisAddonOwnership(pool, {
      addonId: ADDON, siteId: site.id, fromUserId: stranger, toUserId: successor,
    });
    expect(await ownerOf(rows[0]!.id)).toEqual({ owner: stranger, author: stranger });
  });
});
