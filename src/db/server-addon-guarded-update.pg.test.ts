import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhisAddonSchema, dropPhisAddonSchema } from "./server-addon-schema.mts";
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
 * Adding to a column and guarding an update, against a real database and real concurrency.
 *
 * What is shown is the thing a handler cannot do on its own: test and write in one step. Ten orders for
 * one item each arrive at once against a stock of five, and exactly five of them get it -- not because
 * anybody locked anything, but because the statement that subtracts is the one that checks. And a change
 * of state delivered several times happens once: every repetition finds the bit already set and answers
 * null.
 */

const SCHEMA = "phis_addon_pgtest_guarded";
const ADDON = "@pgtest/guarded";

const schema = {
  descriptorVersion: 1 as const,
  version: 1,
  tables: [
    {
      name: "listing",
      siteScoped: true,
      ownerScoped: true,
      columns: [
        { name: "id", type: "identity" as const },
        { name: "stock", type: "integer" as const, nullable: true },
        { name: "sold", type: "bigInteger" as const, default: { kind: "literal" as const, value: 0 } },
        { name: "flags", type: "integer" as const, default: { kind: "literal" as const, value: 0 } },
      ],
      primaryKey: ["id"],
      constraints: [
        { kind: "range" as const, name: "listing_stock_range", column: "stock", min: 0 },
      ],
    },
  ],
};

const OPENED = 4;

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
    parameters: {
      add: [{ name: "stock", type: "integer", nullable: true }],
      reserve: [
        { name: "id", type: "bigInteger" },
        { name: "quantity", type: "integer" },
        { name: "taken", type: "integer" },
      ],
      adjust: [{ name: "id", type: "bigInteger" }, { name: "by", type: "integer" }],
      open: [{ name: "id", type: "bigInteger" }],
    },
    queries: [
      {
        kind: "insert",
        name: "add",
        table: "listing",
        values: [{ column: "stock", value: { kind: "parameter", name: "stock" } }],
      },
      {
        // Unlimited stock is null and stays null: the guard lets it through, and null plus anything is
        // null, so the same query serves both kinds of listing.
        kind: "update",
        name: "reserve",
        table: "listing",
        set: [
          { column: "stock", add: { kind: "parameter", name: "taken" } },
          { column: "sold", add: { kind: "parameter", name: "quantity" } },
        ],
        idParameter: "id",
        where: {
          kind: "any",
          conditions: [
            { kind: "isNull", column: "stock" },
            {
              kind: "compare", column: "stock", operator: ">=",
              value: { kind: "parameter", name: "quantity" },
            },
          ],
        },
      },
      {
        // No guard: the range constraint is then the only thing that stops the stock going negative.
        kind: "update",
        name: "adjust",
        table: "listing",
        set: [{ column: "stock", add: { kind: "parameter", name: "by" } }],
        idParameter: "id",
      },
      {
        kind: "update",
        name: "open",
        table: "listing",
        set: [{ column: "flags", add: { kind: "literal", value: OPENED } }],
        idParameter: "id",
        where: {
          kind: "flags", column: "flags", mask: { kind: "literal", value: OPENED }, match: "none",
        },
      },
    ],
  },
  migrationVersion: 1,
} as unknown as PhisAddonManifestV1;

let migrationPool: Pool;

describe("an update that adds, guarded by a condition", () => {
  let site: PhiTestSite;
  let seller: number;
  let stranger: number;

  function data(actorUserId: number) {
    return buildPhisAddonCapabilities({
      manifest,
      manifestDigest: "pgtest-guarded",
      siteId: site.id,
      siteKey: site.key,
      actorUserId,
    }).data!;
  }

  async function stockOf(id: unknown) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ stock: number | null; sold: string; flags: number }>(
      `SELECT stock, sold, flags FROM ${SCHEMA}.listing WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-guarded");
    seller = await createPhiTestUser(site);
    stranger = await createPhiTestUser(site);

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

  it("takes stock only while there is enough, and answers null when there is not", async () => {
    const row = await data(seller).insert("add", { stock: 3 });
    const id = String(row!.id);

    expect(await data(seller).update("reserve", { id, quantity: 2, taken: -2 }))
      .toMatchObject({ stock: 1 });
    // One left, two asked for: nothing is written, and the answer is the one a missing row gets.
    expect(await data(seller).update("reserve", { id, quantity: 2, taken: -2 })).toBeNull();
    expect(await stockOf(id)).toMatchObject({ stock: 1, sold: "2" });
  });

  it("gives exactly the stock there is to orders that arrive at once", async () => {
    const row = await data(seller).insert("add", { stock: 5 });
    const id = String(row!.id);

    const answers = await Promise.all(
      Array.from({ length: 10 }, () =>
        data(seller).update("reserve", { id, quantity: 1, taken: -1 })
      ),
    );
    expect(answers.filter((answer) => answer !== null)).toHaveLength(5);
    expect(await stockOf(id)).toMatchObject({ stock: 0, sold: "5" });
  });

  it("leaves unlimited stock unlimited, and still counts what was sold", async () => {
    const row = await data(seller).insert("add", { stock: null });
    const id = String(row!.id);
    expect(await data(seller).update("reserve", { id, quantity: 7, taken: -7 }))
      .toMatchObject({ stock: null });
    expect(await stockOf(id)).toMatchObject({ stock: null, sold: "7" });
  });

  it("keeps the range constraint, which refuses an unguarded sum loudly", async () => {
    const row = await data(seller).insert("add", { stock: 1 });
    const id = String(row!.id);
    expect(await data(seller).update("adjust", { id, by: 4 })).toMatchObject({ stock: 5 });
    await expect(data(seller).update("adjust", { id, by: -6 })).rejects.toThrow(/listing_stock_range/);
    expect(await stockOf(id)).toMatchObject({ stock: 5 });
  });

  it("sets a flag bit once, however often the change is delivered", async () => {
    const row = await data(seller).insert("add", { stock: 1 });
    const id = String(row!.id);

    const answers = await Promise.all(
      Array.from({ length: 5 }, () => data(seller).update("open", { id })),
    );
    expect(answers.filter((answer) => answer !== null)).toHaveLength(1);
    expect(await data(seller).update("open", { id })).toBeNull();
    expect((await stockOf(id)).flags).toBe(OPENED);
  });

  it("still asks the ladder first: a stranger's guarded update answers null and writes nothing", async () => {
    const row = await data(seller).insert("add", { stock: 4 });
    const id = String(row!.id);
    expect(await data(stranger).update("reserve", { id, quantity: 1, taken: -1 })).toBeNull();
    expect(await stockOf(id)).toMatchObject({ stock: 4, sold: "0" });
  });
});
