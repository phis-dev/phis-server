import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhisAddonSchema, dropPhisAddonSchema } from "./server-addon-schema.mts";
import { getPhisConfigSync } from "@/lib/config";
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
 * Storing a document, which only PostgreSQL can confirm.
 *
 * A `json` column could be declared long before it could be written: every literal this vocabulary
 * offers is a scalar and so was every parameter type, so an Add-on could own a document column and
 * never put a document in it.
 *
 * The case worth a database is the array. `pg` serialises a plain object to JSON of its own accord and
 * serialises an array to a PostgreSQL array literal instead -- so `{}` would have gone in and `[]`
 * would have been refused by the column, which is the worst of the three possible outcomes: one shape
 * working and the other not, discovered by whoever first stored a list.
 */

const SCHEMA = "phis_addon_pgtest_json";
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
          { name: "name", type: "string" as const, maxLength: 200 },
          { name: "attributes", type: "json" as const, nullable: true },
          { name: "media", type: "json" as const, nullable: true },
        ],
        primaryKey: ["id"],
      },
    ],
  },
};

const manifest = {
  manifestVersion: 1,
  addonId: "@pgtest/json",
  packageName: "@pgtest/json",
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
      all: [],
      add: [
        { name: "name", type: "text" },
        { name: "attributes", type: "json", nullable: true },
        { name: "media", type: "json", nullable: true },
      ],
      describe: [
        { name: "id", type: "bigInteger" },
        { name: "attributes", type: "json", nullable: true },
      ],
    },
    queries: [
      { kind: "select", name: "all", table: "offering", orderBy: [{ column: "id", direction: "asc" }], limit: 25 },
      {
        kind: "insert",
        name: "add",
        table: "offering",
        values: [
          { column: "name", value: { kind: "parameter", name: "name" } },
          { column: "attributes", value: { kind: "parameter", name: "attributes" } },
          { column: "media", value: { kind: "parameter", name: "media" } },
        ],
      },
      {
        kind: "update",
        name: "describe",
        table: "offering",
        set: [{ column: "attributes", value: { kind: "parameter", name: "attributes" } }],
        idParameter: "id",
      },
    ],
  },
  migrationVersion: 1,
} as unknown as PhisAddonManifestV1;

let migrationPool: Pool;

describe("storing a document on an Add-on's own table", () => {
  let site: PhiTestSite;

  function data() {
    return buildPhisAddonCapabilities({
      manifest,
      manifestDigest: "pgtest-json",
      siteId: site.id,
      actorUserId: null,
    }).data!;
  }

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-json");

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

  it("round-trips an object as the document it was, not as its text", async () => {
    const attributes = {
      addonId: "@acme/crm",
      moduleIds: ["@acme/crm/modules/contacts"],
      category: "commerce",
      nested: { phisVersion: ">=1.2 <2" },
    };
    const inserted = await data().insert("add", {
      name: "acme-crm",
      attributes,
      media: null,
    });
    // Deeply equal rather than a string: a column that stored the serialised text would come back as
    // one, and every reader written against the format would then be reading a string.
    expect(inserted!.attributes).toEqual(attributes);
  });

  it("stores an array as a document rather than as a PostgreSQL array", async () => {
    /*
     * The reason the parameter type has to reach the compiler at all. Left to `pg`, this value becomes
     * `{"{\"role\":\"icon\"}"}` -- an array literal of one text element -- and the column refuses it.
     */
    const media = [{ role: "icon", url: "https://acme.example/icon.png" }, { role: "shot", url: "…" }];
    const inserted = await data().insert("add", {
      name: "with-media",
      attributes: null,
      media,
    });
    expect(inserted!.media).toEqual(media);
  });

  it("keeps a null a null, rather than storing the JSON word for one", async () => {
    // `JSON.stringify(null)` is the four characters `null`, which in a jsonb column is a stored JSON
    // null and not an absent value -- and `IS NULL` would then answer false for a column nobody set.
    const inserted = await data().insert("add", {
      name: "bare",
      attributes: null,
      media: null,
    });
    expect(inserted!.attributes).toBeNull();

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ absent: boolean }>(
      `SELECT attributes IS NULL AS absent FROM ${SCHEMA}.offering WHERE id = $1`,
      [inserted!.id],
    );
    expect(rows[0]!.absent).toBe(true);
  });

  it("replaces a stored document wholesale on update", async () => {
    // There is no merge in this vocabulary and there should not be one: a partial write would need a
    // path to write at, which is the document query language `json` deliberately does not open.
    const inserted = await data().insert("add", {
      name: "replaceable",
      attributes: { category: "content", keep: true },
      media: null,
    });
    const changed = await data().update("describe", {
      id: inserted!.id as number,
      attributes: { category: "commerce" },
    });
    expect(changed!.attributes).toEqual({ category: "commerce" });
  });
});
