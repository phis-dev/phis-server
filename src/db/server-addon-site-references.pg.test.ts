import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhiServerAddonSchema, dropPhiServerAddonSchema } from "./server-addon-schema.mts";
import { getPhiServerConfigSync } from "@/lib/config";
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
 * A reference between two of the Add-on's own tables, and the Site it has to carry.
 *
 * The Site filter Core puts into every statement guards what a query reads. It does not guard what a
 * value points at: an insert names the target row by id, the id is a number like any other, and a row of
 * one Site naming a row of another is a perfectly valid write. Nothing about the declaration would show
 * it -- the column reads the same either way and the constraint still holds.
 *
 * So the boundary has to be in the constraint. The second case here is the one that used to go through.
 */

const SCHEMA = "phis_addon_pgtest_siterefs";
const ADDON = "@pgtest/siterefs";

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
          { name: "name", type: "string" as const, maxLength: 64 },
        ],
        primaryKey: ["id"],
      },
      {
        name: "review",
        siteScoped: true,
        columns: [
          { name: "id", type: "identity" as const },
          { name: "offering_id", references: { table: "offering" }, onDelete: "cascade" as const },
          { name: "body", type: "string" as const, maxLength: 200 },
        ],
        primaryKey: ["id"],
      },
    ],
  },
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
  schema: target.descriptor,
  queries: {
    parameters: {
      add_offering: [{ name: "name", type: "text" }],
      add_review: [
        { name: "offering_id", type: "bigInteger" },
        { name: "body", type: "text" },
      ],
      all_reviews: [],
    },
    queries: [
      {
        kind: "insert",
        name: "add_offering",
        table: "offering",
        values: [{ column: "name", value: { kind: "parameter", name: "name" } }],
      },
      {
        kind: "insert",
        name: "add_review",
        table: "review",
        values: [
          { column: "offering_id", value: { kind: "parameter", name: "offering_id" } },
          { column: "body", value: { kind: "parameter", name: "body" } },
        ],
      },
      { kind: "select", name: "all_reviews", table: "review", limit: 25 },
    ],
  },
  migrationVersion: 1,
} as unknown as PhiServerAddonManifestV1;

let migrationPool: Pool;

describe("a reference between two Site-scoped tables", () => {
  let siteA: PhiTestSite;
  let siteB: PhiTestSite;

  function data(site: PhiTestSite) {
    return buildPhiServerAddonCapabilities({
      manifest,
      manifestDigest: "pgtest-siterefs",
      siteId: site.id,
      actorUserId: null,
    }).data!;
  }

  beforeAll(async () => {
    await requirePhiTestDatabase();
    siteA = await createPhiTestSite("addon-siterefs-a");
    siteB = await createPhiTestSite("addon-siterefs-b");

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

  it("is accepted by PostgreSQL at all, which the composite key is there for", async () => {
    // The pair is only allowed against a unique key covering exactly those columns. If Core had not laid
    // one down on the target, the schema above would have failed to apply and this file would not run.
    const offering = await data(siteA).insert("add_offering", { name: "acme" });
    const review = await data(siteA).insert("add_review", {
      offering_id: String(offering!.id),
      body: "works",
    });
    expect(review).toMatchObject({ body: "works" });
  });

  it("refuses a row of one Site pointing at a row of another", async () => {
    const offering = await data(siteA).insert("add_offering", { name: "acme-two" });

    /*
     * Core writes the Site itself, so this caller cannot claim Site A -- but it can name Site A's row,
     * and that is the whole of the hole. Before the reference carried the Site, this insert succeeded:
     * a review filed on one tenant's offering, stored under another, invisible to both because each
     * query only ever reads its own Site.
     */
    await expect(data(siteB).insert("add_review", {
      offering_id: String(offering!.id),
      body: "from the other Site",
    })).rejects.toThrow(/violates foreign key constraint "review_offering_id_fk"/);

    expect((await data(siteB).select("all_reviews")).rows).toHaveLength(0);
  });

  it("cascades within the Site, so a removed offering takes its reviews", async () => {
    const offering = await data(siteA).insert("add_offering", { name: "acme-three" });
    await data(siteA).insert("add_review", { offering_id: String(offering!.id), body: "temporary" });

    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM ${SCHEMA}."offering" WHERE id = $1`, [offering!.id]);

    expect((await data(siteA).select("all_reviews")).rows.some((row) => row.body === "temporary"))
      .toBe(false);
  });
});
