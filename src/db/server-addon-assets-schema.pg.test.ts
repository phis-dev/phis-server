import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhiServerAddonSchema, dropPhiServerAddonSchema } from "./server-addon-schema.mts";
import { getPhiServerConfigSync } from "@/lib/config";
import { buildPhiServerAddonCapabilities } from "@/lib/addons/capabilities";
import { ensureAddonMediaSpace } from "@/db/media-spaces";
import { validatePhiServerAddonQueryCatalog } from "@/lib/addons/query-descriptor";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { PhiServerAddonManifestV1 } from "@/lib/addons/contract";

/**
 * The table Core keeps beside one that declares files, against a real database.
 *
 * The unit tests say what SQL is generated. What they cannot say is whether PostgreSQL accepts it, and
 * three of the properties here only exist once it does: a composite foreign key needs a unique key that
 * covers exactly its columns, a partial unique index has to permit the pending row it is not about, and
 * the cascade has to actually run.
 *
 * The cascade is the reason the whole table exists. An offering removed takes the rows describing its
 * files, and the objects those rows named become collectable -- which is the question Core could not
 * answer at all while nothing linked a row to an object.
 */

const SCHEMA = "phis_addon_pgtest_assets";
const ADDON = "@pgtest/assets";
const ASSETS = `${SCHEMA}.offering_assets`;

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
        assets: [
          {
            name: "package",
            cardinality: "one" as const,
            maxBytes: 1_048_576,
            contentTypes: ["application/gzip"],
          },
          {
            name: "screenshots",
            cardinality: "many" as const,
            maxBytes: 524_288,
            contentTypes: ["image/png", "image/webp"],
          },
        ],
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
      drop_offering: [{ name: "id", type: "bigInteger" }],
    },
    queries: [
      {
        kind: "insert",
        name: "add_offering",
        table: "offering",
        values: [{ column: "name", value: { kind: "parameter", name: "name" } }],
      },
      { kind: "delete", name: "drop_offering", table: "offering", idParameter: "id" },
    ],
  },
  migrationVersion: 1,
} as unknown as PhiServerAddonManifestV1;

let migrationPool: Pool;

describe("the asset table Core adds beside a table that declares files", () => {
  let siteA: PhiTestSite;
  let siteB: PhiTestSite;

  function data(site: PhiTestSite) {
    return buildPhiServerAddonCapabilities({
      manifest,
      manifestDigest: "pgtest-assets",
      siteId: site.id,
      actorUserId: null,
    }).data!;
  }

  /** A file, as Core records one. The link rows below point at these. */
  async function writeFile(site: PhiTestSite) {
    const pool = await requirePhiTestDatabase();
    const space = await ensureAddonMediaSpace(site.id, ADDON);
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_assets
         (site_id, space_id, storage_profile_id, storage_key, original_name, content_type,
          bytes, lifecycle_status, delivery_policy)
       VALUES ($1, $2, $3, $4, 'x.tgz', 'application/gzip', 10, 2, 1)
       RETURNING id`,
      [site.id, space.id, space.defaultStorageProfileId, `addon/${crypto.randomUUID()}`],
    );
    return rows[0]!.id;
  }

  /** Core writes these rows; there is no query vocabulary for them, and there is not meant to be. */
  async function writeAsset(input: {
    site: PhiTestSite;
    ownerId: string;
    slot: string;
    mediaAssetId?: number;
  }) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ${ASSETS} (site_id, owner_id, slot, media_asset_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        input.site.id,
        input.ownerId,
        input.slot,
        input.mediaAssetId ?? await writeFile(input.site),
      ],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    await requirePhiTestDatabase();
    siteA = await createPhiTestSite("addon-assets-a");
    siteB = await createPhiTestSite("addon-assets-b");

    const config = getPhiServerConfigSync().database;
    if (!config?.migrationUri || !config.uri) {
      throw new Error("These tests need database.migrationUri and database.uri.");
    }
    // The Space points at the Add-on, so the Add-on has to be installed before it can have one.
    await (await requirePhiTestDatabase()).query(
      `INSERT INTO phis.server_addons
         (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
       VALUES ($1, $1, '0.1.0', '1', repeat('0', 64), 'pgtest')
       ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON],
    );

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
    await (await requirePhiTestDatabase()).query(
      `DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON],
    );
    await closePhiTestPool();
  });

  it("is accepted by PostgreSQL, which the parent's composite key is what makes possible", async () => {
    // A composite foreign key is only allowed against a unique key covering exactly its columns. Core
    // lays that key on the parent even where nothing the Add-on declared points at it -- without that
    // pass, the schema above would not have applied and this file would not run.
    const offering = await data(siteA).insert("add_offering", { name: "acme" });
    const id = await writeAsset({ site: siteA, ownerId: String(offering!.id), slot: "package" });
    expect(id).toBeTruthy();
  });

  it("removes what linked a row's files when the row goes", async () => {
    /*
     * The whole point. Before this table existed, deleting an offering left its objects in the store
     * with nothing anywhere saying whose they had been -- counted against the quota, findable only by
     * listing a bucket, and indistinguishable from objects still in use.
     */
    const offering = await data(siteA).insert("add_offering", { name: "acme-cascade" });
    await writeAsset({ site: siteA, ownerId: String(offering!.id), slot: "package" });
    await writeAsset({ site: siteA, ownerId: String(offering!.id), slot: "screenshots" });

    const removed = await data(siteA).delete("drop_offering", { id: String(offering!.id) });
    // The row comes back, so the caller can still read what it named before it went.
    expect(removed).toMatchObject({ name: "acme-cascade" });

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query(
      `SELECT id FROM ${ASSETS} WHERE owner_id = $1`,
      [String(offering!.id)],
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses a link hung on a row of another Site", async () => {
    // The same hole the Site-bound reference closed, in the table Core writes itself: the owner id is a
    // number like any other, and without the Site in the key it would name any Site's row.
    const offering = await data(siteA).insert("add_offering", { name: "acme-foreign" });
    await expect(writeAsset({ site: siteB, ownerId: String(offering!.id), slot: "package" }))
      .rejects.toThrow(/violates foreign key constraint "offering_assets_owner_id_fk"/);
  });

  it("refuses a slot the manifest never declared", async () => {
    const offering = await data(siteA).insert("add_offering", { name: "acme-slot" });
    await expect(writeAsset({ site: siteA, ownerId: String(offering!.id), slot: "trailer" }))
      .rejects.toThrow(/offering_assets_slot_check/);
  });

  it("holds a single-valued slot to one file", async () => {
    const offering = await data(siteA).insert("add_offering", { name: "acme-one" });
    await writeAsset({ site: siteA, ownerId: String(offering!.id), slot: "package" });
    await expect(writeAsset({ site: siteA, ownerId: String(offering!.id), slot: "package" }))
      .rejects.toThrow(/offering_assets_one_idx/);
  });

  it("lets a slot that accumulates accumulate", async () => {
    const offering = await data(siteA).insert("add_offering", { name: "acme-many" });
    await writeAsset({ site: siteA, ownerId: String(offering!.id), slot: "screenshots" });
    await writeAsset({ site: siteA, ownerId: String(offering!.id), slot: "screenshots" });

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query(
      `SELECT id FROM ${ASSETS} WHERE owner_id = $1 AND slot = 'screenshots'`,
      [String(offering!.id)],
    );
    expect(rows).toHaveLength(2);
  });

  it("refuses two rows on one file", async () => {
    // Otherwise removing the first would take the second one's subject away, and neither row shows why.
    const offering = await data(siteA).insert("add_offering", { name: "acme-dup" });
    const mediaAssetId = await writeFile(siteA);
    await writeAsset({ site: siteA, ownerId: String(offering!.id), slot: "screenshots", mediaAssetId });
    await expect(
      writeAsset({ site: siteA, ownerId: String(offering!.id), slot: "screenshots", mediaAssetId }),
    ).rejects.toThrow(/offering_assets_media_asset_id_uq/);
  });

  it("lets go of the link when the file is removed in the Media view", async () => {
    /*
     * The cascade that makes deleting a file a usable answer to somebody uploading rubbish: the link
     * goes, the offering stays, and the Add-on simply has nothing to deliver for that slot.
     */
    const pool = await requirePhiTestDatabase();
    const offering = await data(siteA).insert("add_offering", { name: "acme-moderated" });
    const mediaAssetId = await writeFile(siteA);
    const link = await writeAsset({
      site: siteA, ownerId: String(offering!.id), slot: "screenshots", mediaAssetId,
    });

    await pool.query(`DELETE FROM phis.media_assets WHERE id = $1`, [mediaAssetId]);

    expect((await pool.query(`SELECT id FROM ${ASSETS} WHERE id = $1`, [link])).rows).toHaveLength(0);
    // The parent is untouched: it has lost a file, not its existence.
    expect((await pool.query(
      `SELECT id FROM ${SCHEMA}.offering WHERE id = $1`, [String(offering!.id)],
    )).rows).toHaveLength(1);
  });

  it("gives the Add-on no way to declare a query against it", () => {
    /*
     * The columns are Core's. What an object is called, how big it turned out and whether it ever
     * arrived are answers Core writes -- an Add-on that could write them could name an object outside
     * its own prefix, or mark a transfer complete that never happened.
     *
     * The table is derived rather than declared, so it is simply not in the set a query may name, and
     * this is the validator saying so rather than a rule written a second time.
     */
    const issues: string[] = [];
    validatePhiServerAddonQueryCatalog(
      {
        parameters: { peek: [] },
        queries: [{ kind: "select", name: "peek", table: "offering_assets", limit: 5 }],
      },
      target.descriptor,
      "queries",
      issues,
    );
    expect(issues.join("\n")).toMatch(/does not name a table this Add-on declares/);
  });
});
