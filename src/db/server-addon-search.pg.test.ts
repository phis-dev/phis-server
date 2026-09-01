import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhiServerAddonSchema, dropPhiServerAddonSchema } from "./server-addon-schema.mts";
import { getPhiServerConfigSync } from "@/lib/config";
import { quotePhiIdentifier } from "@/lib/addons/schema-ddl";
import { buildPhiServerAddonCapabilities } from "@/lib/addons/capabilities";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { PhiServerAddonManifestV1 } from "@/lib/addons/contract";

/**
 * What `contains` does against a real database, on both counts that matter.
 *
 * Correctness: a value is a value. Somebody searching a catalogue for "100%" means those four
 * characters, and unescaped the per cent sign would be a wildcard matching everything -- a search that
 * returns too much rather than an error, which is the kind that ships.
 *
 * And cost: the operator is only worth having if the declared text index is actually used. That is a
 * planner decision, not a property of the SQL, so it is read out of EXPLAIN rather than assumed.
 */

const SCHEMA = "phis_addon_pgtest_search";
const target = {
  schemaName: SCHEMA,
  descriptor: {
    descriptorVersion: 1 as const,
    version: 1,
    tables: [
      {
        name: "offering",
        siteScoped: true,
        columns: [
          { name: "id", type: "identity" as const },
          { name: "title", type: "string" as const, maxLength: 200 },
        ],
        primaryKey: ["id"],
        indexes: [{ name: "by_title", kind: "text" as const, columns: ["title"] }],
      },
    ],
  },
};

const manifest = {
  manifestVersion: 1,
  addonId: "@pgtest/search",
  packageName: "@pgtest/search",
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
    parameters: { find: [{ name: "q", type: "text", nullable: true }] },
    queries: [
      {
        kind: "select",
        name: "find",
        table: "offering",
        columns: ["id", "title"],
        where: {
          kind: "whenPresent",
          parameter: "q",
          condition: { kind: "contains", column: "title", value: { kind: "parameter", name: "q" } },
        },
        orderBy: [{ column: "id", direction: "asc" }],
        limit: 25,
      },
    ],
  },
  migrationVersion: 1,
} as unknown as PhiServerAddonManifestV1;

let migrationPool: Pool;

describe("contains, against a real database", () => {
  let site: PhiTestSite;

  function data() {
    return buildPhiServerAddonCapabilities({
      manifest,
      manifestDigest: "pgtest-search",
      siteId: site.id,
      actorUserId: null,
    }).data!;
  }

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-search");

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

    const pool = await requirePhiTestDatabase();
    const titles = ["Acme CRM Suite", "Discount 100% off", "underscore_name", "Ordinary offering"];
    for (const title of titles) {
      await pool.query(
        `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."offering" (site_id, title) VALUES ($1, $2)`,
        [site.id, title],
      );
    }
    // Enough rows that a sequential scan would be the wrong plan if the index were not used.
    await pool.query(
      `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."offering" (site_id, title)
       SELECT $1, 'Filler offering ' || i FROM generate_series(1, 20000) i`,
      [site.id],
    );
    const client2 = await migrationPool.connect();
    try {
      await client2.query(`ANALYZE ${quotePhiIdentifier(SCHEMA)}."offering"`);
    } finally {
      client2.release();
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

  it("finds a fragment, whatever the case", async () => {
    const page = await data().select("find", { q: "crm" });
    expect(page.rows.map((row) => row.title)).toEqual(["Acme CRM Suite"]);
  });

  it("treats a per cent sign as a character rather than as everything", async () => {
    const page = await data().select("find", { q: "100%" });
    expect(page.rows.map((row) => row.title)).toEqual(["Discount 100% off"]);
  });

  it("treats an underscore as a character rather than as any character", async () => {
    const page = await data().select("find", { q: "underscore_name" });
    expect(page.rows).toHaveLength(1);
    const wildcarded = await data().select("find", { q: "underscore.name" });
    expect(wildcarded.rows).toHaveLength(0);
  });

  it("searches nothing when the parameter is absent", async () => {
    const page = await data().select("find", { q: null }, { limit: 5 });
    expect(page.rows).toHaveLength(5);
  });

  it("uses the declared text index instead of reading the table", async () => {
    const pool = await requirePhiTestDatabase();
    const sql =
      `SELECT id, title FROM ${quotePhiIdentifier(SCHEMA)}."offering" ` +
      `WHERE site_id = $1 AND ("title" ILIKE ('%' || replace(replace(replace($2, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')) ` +
      `ORDER BY id ASC LIMIT $3`;
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, [site.id, "CRM", 25]);
    const plan = JSON.stringify(rows[0]["QUERY PLAN"][0].Plan);
    expect(plan).toContain("Bitmap Index Scan");
    expect(plan).toContain("offering_by_title_idx");
  });
});
