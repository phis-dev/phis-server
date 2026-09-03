import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhisAddonSchema, dropPhisAddonSchema } from "./server-addon-schema.mts";
import { getPhisConfigSync } from "@/lib/config";
import { quotePhiIdentifier } from "@/lib/addons/schema-ddl";
import { buildPhisAddonCapabilities } from "@/lib/addons/capabilities";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { PhisAddonManifestV1 } from "@/lib/addons/contract";

/**
 * Counting and summarising, and the list parameter that makes the answer fit a page.
 *
 * The two exist for one question asked in two calls: read a page of offerings, then ask what the ratings
 * say about exactly those. Neither half is enough alone -- an aggregate over the whole table answers
 * about rows the caller never saw, and a fixed `in` list cannot name keys that were only known once the
 * first page came back. Together they are what a join would have been asked to do.
 */

const SCHEMA = "phis_addon_pgtest_aggregate";

const target = {
  schemaName: SCHEMA,
  descriptor: {
    descriptorVersion: 1 as const,
    version: 1,
    tables: [
      {
        name: "rating",
        siteScoped: true,
        columns: [
          { name: "id", type: "identity" as const },
          { name: "offering", type: "string" as const, maxLength: 64 },
          { name: "score", type: "smallInteger" as const },
          { name: "note", type: "string" as const, maxLength: 200, nullable: true },
        ],
        primaryKey: ["id"],
      },
    ],
  },
};

const manifest = {
  manifestVersion: 1,
  addonId: "@pgtest/aggregate",
  packageName: "@pgtest/aggregate",
  packageVersion: "0.1.0",
  serverAbi: "1",
  capabilities: [],
  serviceProviders: [],
  requiredCoreCapabilities: ["@phis/server/data:v1"],
  apiRoutes: [],
  hooks: [],
  jobs: [],
  settings: [],
  schema: target.descriptor,
  queries: {
    parameters: {
      total: [],
      by_offering: [],
      for_page: [{ name: "offerings", type: "text", list: true }],
    },
    queries: [
      {
        kind: "aggregate",
        name: "total",
        table: "rating",
        aggregates: [
          { function: "count", as: "ratings" },
          { function: "avg", column: "score", as: "average" },
        ],
      },
      {
        kind: "aggregate",
        name: "by_offering",
        table: "rating",
        groupBy: ["offering"],
        aggregates: [
          { function: "count", as: "ratings" },
          { function: "avg", column: "score", as: "average" },
          { function: "max", column: "score", as: "best" },
        ],
        limit: 25,
      },
      {
        // The one the listing actually calls: the keys of the page just read, and nothing else.
        kind: "aggregate",
        name: "for_page",
        table: "rating",
        where: { kind: "in", column: "offering", parameter: "offerings" },
        groupBy: ["offering"],
        aggregates: [
          { function: "count", as: "ratings" },
          { function: "avg", column: "score", as: "average" },
        ],
        limit: 25,
      },
    ],
  },
  migrationVersion: 1,
} as unknown as PhisAddonManifestV1;

let migrationPool: Pool;

describe("aggregating a declared table", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;

  function data(which: PhiTestSite = site) {
    return buildPhisAddonCapabilities({
      manifest,
      manifestDigest: "pgtest-aggregate",
      siteId: which.id,
      actorUserId: null,
    }).data!;
  }

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-aggregate");
    other = await createPhiTestSite("addon-aggregate-other");

    const config = getPhisConfigSync().database;
    if (!config?.migrationUri || !config.uri) {
      throw new Error("These tests need database.migrationUri and database.uri.");
    }
    const servingRole = decodeURIComponent(new URL(config.uri).username);
    migrationPool = new Pool({ connectionString: config.migrationUri });
    const client = await migrationPool.connect();
    try {
      await dropPhisAddonSchema(client, SCHEMA);
      await applyPhisAddonSchema(client, target, servingRole);
    } finally {
      client.release();
    }

    const pool = await requirePhiTestDatabase();
    const rows: [string, number][] = [
      ["acme", 5], ["acme", 4], ["acme", 3],
      ["serif", 2], ["serif", 4],
      ["zeta", 5],
    ];
    for (const [offering, score] of rows) {
      await pool.query(
        `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."rating" (site_id, offering, score)
         VALUES ($1, $2, $3)`,
        [site.id, offering, score],
      );
    }
    // One on the other Site, which every answer below must be blind to.
    await pool.query(
      `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."rating" (site_id, offering, score)
       VALUES ($1, 'acme', 1)`,
      [other.id],
    );
  });

  afterAll(async () => {
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
    await closePhiTestPool();
  });

  it("answers the whole table in one row, and carries no cursor", async () => {
    const page = await data().aggregate("total");
    expect(page.rows).toHaveLength(1);
    expect(page.cursor).toBeNull();
    expect(Number(page.rows[0]!.ratings)).toBe(6);
    // 23 over 6. `numeric` arrives as a string, which is the point: this is not a JavaScript number.
    expect(String(page.rows[0]!.average)).toMatch(/^3\.8333/);
  });

  it("counts within the Site, like every other statement Core writes", async () => {
    // Seven rows exist; six are this Site's. The filter is in the statement, not in the caller.
    expect(Number((await data(other).aggregate("total")).rows[0]!.ratings)).toBe(1);
  });

  it("gives one row per group, ordered by the group", async () => {
    const page = await data().aggregate("by_offering");
    expect(page.rows.map((row) => row.offering)).toEqual(["acme", "serif", "zeta"]);
    expect(page.rows.map((row) => Number(row.ratings))).toEqual([3, 2, 1]);
    expect(page.rows.map((row) => Number(row.best))).toEqual([5, 4, 5]);
  });

  it("pages the groups, and hands back no column of its own making", async () => {
    /*
     * The grouping columns are the ordering and are unique by construction -- `GROUP BY` yields each
     * combination once -- so there is no tie for Core to break and the keyset is exact. Which is why the
     * cursor clause sits in `WHERE`, before the grouping: dropping the rows that sort before it drops
     * exactly the groups that sort before it.
     */
    const first = await data().aggregate("by_offering", {}, { limit: 2 });
    expect(first.rows.map((row) => row.offering)).toEqual(["acme", "serif"]);
    expect(first.cursor).not.toBeNull();
    expect(Object.keys(first.rows[0]!).some((key) => key.startsWith("__phi"))).toBe(false);

    const second = await data().aggregate("by_offering", {}, { limit: 2, cursor: first.cursor });
    expect(second.rows.map((row) => row.offering)).toEqual(["zeta"]);
    expect(second.cursor).toBeNull();
  });

  it("answers about the keys the caller brings, which is what a listing needs", async () => {
    const page = await data().aggregate("for_page", { offerings: ["acme", "zeta"] });
    expect(page.rows.map((row) => row.offering)).toEqual(["acme", "zeta"]);
    expect(page.rows.map((row) => Number(row.ratings))).toEqual([3, 1]);
  });

  it("takes an empty list as an empty answer rather than as no filter", async () => {
    expect((await data().aggregate("for_page", { offerings: [] })).rows).toHaveLength(0);
  });

  it("refuses a single value where a list was declared", async () => {
    await expect(data().aggregate("for_page", { offerings: "acme" }))
      .rejects.toThrow(/declares "offerings" as a list/);
  });

  it("refuses a list longer than a page could ever be", async () => {
    const many = Array.from({ length: 501 }, (_, index) => `offering-${index}`);
    await expect(data().aggregate("for_page", { offerings: many }))
      .rejects.toThrow(/at most 500/);
  });
});
