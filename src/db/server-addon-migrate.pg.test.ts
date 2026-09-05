import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  digestPhisAddonSchemaDescriptor,
  migratePhisAddon,
  purgePhisAddon,
} from "./server-addon-migrate.mts";
import type { PhisAddonManifestV1 } from "@/lib/addons/contract";
import { getPhisConfigSync } from "@/lib/config";
import { createMediaAsset } from "./media.ts";
import { ensureAddonMediaSpace } from "./media-spaces.ts";
import { incidentSchemaDescriptor } from "../../test/fixtures/addon-schema.ts";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
} from "../../test/pg/harness";

/**
 * The runner end to end: a manifest arrives, a schema exists, and the catalog says so afterwards.
 *
 * The refusals matter more than the success here. Before v1 the only comparison this executes is the one
 * against nothing, and both ways of asking for anything else have to end with an instruction rather than
 * an attempt.
 */

const ADDON_ID = "@pgtest/tracker";
const SCHEMA = "phis_addon_pgtest_tracker";
const RELEASE = "pgtest-release";

function manifestWith(descriptor = incidentSchemaDescriptor): PhisAddonManifestV1 {
  return {
    manifestVersion: 1,
    addonId: ADDON_ID,
    packageName: "@pgtest/tracker-server",
    packageVersion: "0.1.0",
    serverAbi: "^1",
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: [],
    apiRoutes: [],
    hooks: [],
    jobs: [],
    settings: [],
    queries: null,
  schema: descriptor,
    migrationVersion: descriptor.version,
  };
}

let migrationPool: Pool;
let servingRole: string;

async function readCatalog() {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ schema_name: string | null; migration_version: number }>(
    `SELECT schema_name, migration_version FROM phis.server_addons WHERE addon_id = $1`,
    [ADDON_ID],
  );
  return rows[0] ?? null;
}

async function cleanUp() {
  const pool = await requirePhiTestDatabase();
  await migrationPool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.query(`DELETE FROM phis.server_secrets WHERE addon_id = $1`, [ADDON_ID]);
  await pool.query(`DELETE FROM phis.server_addon_migrations WHERE addon_id = $1`, [ADDON_ID]);
  await pool.query(`DELETE FROM phis.site_addon_user_roles WHERE addon_id = $1`, [ADDON_ID]);
  await pool.query(`DELETE FROM phis.site_server_addons WHERE addon_id = $1`, [ADDON_ID]);
  await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON_ID]);
}

describe("Add-on migration runner", () => {
  beforeAll(async () => {
    await requirePhiTestDatabase();
    const config = getPhisConfigSync().database;
    if (!config?.migrationUri || !config.uri) {
      throw new Error("These tests need database.migrationUri and database.uri.");
    }
    servingRole = decodeURIComponent(new URL(config.uri).username);
    migrationPool = new Pool({ connectionString: config.migrationUri });
    await cleanUp();
  });

  afterAll(async () => {
    await cleanUp();
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.media_discarded_objects`);
    await dropPhiTestSites();
    await migrationPool.end();
    await closePhiTestPool();
  });

  it("registers the Add-on it is about to migrate", async () => {
    const outcome = await migratePhisAddon(
      migrationPool,
      { manifest: manifestWith(), releaseBuildId: RELEASE, servingRole },
      "a".repeat(64),
    );
    expect(outcome.action).toBe("applied");
    expect(outcome.schemaName).toBe(SCHEMA);
    expect(outcome.appliedVersion).toBe(1);

    const catalog = await readCatalog();
    expect(catalog).toMatchObject({ schema_name: SCHEMA, migration_version: 1 });
  });

  it("records what it applied, under the descriptor's own checksum", async () => {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ migration_id: string; checksum: string }>(
      `SELECT migration_id, checksum FROM phis.server_addon_migrations WHERE addon_id = $1`,
      [ADDON_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].migration_id).toBe("schema-v1");
    expect(rows[0].checksum).toBe(digestPhisAddonSchemaDescriptor(incidentSchemaDescriptor));
  });

  it("does nothing the second time", async () => {
    const outcome = await migratePhisAddon(
      migrationPool,
      { manifest: manifestWith(), releaseBuildId: RELEASE, servingRole },
      "a".repeat(64),
    );
    expect(outcome.action).toBe("unchanged");
    expect(outcome.statements).toEqual([]);
  });

  it("is not fooled by a reformatted descriptor", async () => {
    const reordered = {
      ...incidentSchemaDescriptor,
      tables: incidentSchemaDescriptor.tables.map((table) => ({
        primaryKey: table.primaryKey,
        columns: table.columns,
        name: table.name,
        siteScoped: table.siteScoped,
        indexes: table.indexes,
        constraints: table.constraints,
      })),
    };
    const outcome = await migratePhisAddon(
      migrationPool,
      { manifest: manifestWith(reordered), releaseBuildId: RELEASE, servingRole },
      "a".repeat(64),
    );
    expect(outcome.action).toBe("unchanged");
  });

  it("refuses a changed shape that kept its version, and names the remedy", async () => {
    const changed = structuredClone(incidentSchemaDescriptor);
    changed.tables[0].columns.push({ name: "resolution", type: "text", nullable: true });
    await expect(
      migratePhisAddon(
        migrationPool,
        { manifest: manifestWith(changed), releaseBuildId: RELEASE, servingRole },
        "a".repeat(64),
      ),
    ).rejects.toThrow(/changed without changing its version[\s\S]*addon purge/);
  });

  it("refuses to step to a later version before v1", async () => {
    const next = structuredClone(incidentSchemaDescriptor);
    next.version = 2;
    next.tables[0].columns.push({ name: "resolution", type: "text", nullable: true });
    await expect(
      migratePhisAddon(
        migrationPool,
        { manifest: manifestWith(next), releaseBuildId: RELEASE, servingRole },
        "a".repeat(64),
      ),
    ).rejects.toThrow(/Additive migration is not implemented before v1/);
  });

  it("purges the schema, the records, and the Add-on's secrets", async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.server_secrets (reference, addon_id, ciphertext, iv, auth_tag)
       VALUES ($1, $2, 'ab', $3, $4)`,
      [`addon:${ADDON_ID}:token`, ADDON_ID, "0".repeat(24), "0".repeat(32)],
    );

    /*
     * A file in the Add-on's Space, because the catalog row cascades into the Space, the Space into its
     * Assets, and no foreign key reaches into a store. Without the note written first, the object would
     * outlive every row that knew its key -- under the Site's Media prefix, where the storage purge does
     * not look, in a Space the sweep can no longer ask about.
     */
    const site = await createPhiTestSite("addon-purge");
    await pool.query(
      `INSERT INTO phis.site_server_addons (site_id, addon_id) VALUES ($1, $2)
       ON CONFLICT (site_id, addon_id) DO NOTHING`,
      [site.id, ADDON_ID],
    );
    const space = await ensureAddonMediaSpace(site.id, ADDON_ID);
    const asset = await createMediaAsset({
      siteId: site.id,
      spaceId: space.id,
      storageProfileId: space.defaultStorageProfileId,
      storageKey: "media/pgtest/purged-object.bin",
      originalName: "purged-object.bin",
      contentType: "application/octet-stream",
      bytes: 10,
    });

    /*
     * A role this Add-on handed out. It names a role only this manifest defines, so it cannot outlive
     * the package -- and until it was deleted here the foreign key refused the purge outright, which is
     * how an Add-on that had ever granted anything became unpurgeable.
     */
    await pool.query(
      `INSERT INTO phis.site_addon_user_roles (site_id, addon_id, user_id, role, granted_by_user_id)
       VALUES ($1, $2, $3, 'vendor', $3) ON CONFLICT DO NOTHING`,
      [site.id, ADDON_ID, 45],
    );

    const result = await purgePhisAddon(migrationPool, ADDON_ID);
    expect(result.schemaName).toBe(SCHEMA);
    expect(result.droppedSecrets).toBe(1);
    expect(result.discardedObjects).toBe(1);

    // The Asset went with the Space, and what it stood for is on the removal list under its own key.
    const { rows: assets } = await pool.query(
      `SELECT 1 FROM phis.media_assets WHERE id = $1`,
      [asset!.id],
    );
    expect(assets).toHaveLength(0);
    const { rows: noted } = await pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM phis.media_discarded_objects WHERE site_id = $1`,
      [site.id],
    );
    expect(noted.map((row) => row.storage_key)).toEqual(["media/pgtest/purged-object.bin"]);

    const { rows: schemas } = await pool.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
      [SCHEMA],
    );
    expect(schemas).toHaveLength(0);
    expect(await readCatalog()).toBeNull();
  });
});
