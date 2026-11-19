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
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
} from "../../test/pg/harness";

/**
 * The runner end to end: a manifest arrives, a schema exists, and the catalog says so afterwards.
 *
 * The refusals matter as much as the success here: a schema that exists is only ever added to, and
 * every difference adding cannot reach has to end with an instruction rather than an attempt.
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

  it("refuses what adding cannot reach, names each difference and the remedy, and changes nothing", async () => {
    const changed = structuredClone(incidentSchemaDescriptor);
    const incident = changed.tables[0]!;
    // A type that changed, a required column without a default, and a column that is gone.
    incident.columns = incident.columns
      .filter((column) => column.name !== "closed_at")
      .map((column) => column.name === "severity" ? { ...column, type: "integer" as const } : column);
    incident.columns.push({ name: "owner_note", type: "text" });
    incident.constraints = incident.constraints!.filter((constraint) => constraint.name !== "closed_after_opened");
    await expect(
      migratePhisAddon(
        migrationPool,
        { manifest: manifestWith(changed), releaseBuildId: RELEASE, servingRole },
        "a".repeat(64),
      ),
    ).rejects.toThrow(
      /cannot be brought to its new shape by adding[\s\S]*incident\.closed_at[\s\S]*incident\.severity" is smallint and declared integer[\s\S]*incident\.owner_note[\s\S]*addon purge/,
    );
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query(`SELECT checksum FROM phis.server_addon_migrations WHERE addon_id = $1`, [ADDON_ID]);
    expect(rows).toEqual([{ checksum: digestPhisAddonSchemaDescriptor(incidentSchemaDescriptor) }]);
  });

  /*
   * The case this exists for: an installation holds rows nobody may discard, and the Add-on's next
   * release brings a table, a column and an index. Before, that cost a purge.
   */
  function extendedDescriptor() {
    const extended = structuredClone(incidentSchemaDescriptor);
    const incident = extended.tables[0]!;
    incident.columns.push(
      { name: "resolution", type: "text", nullable: true },
      { name: "priority", type: "smallInteger", default: { kind: "literal", value: 3 } },
      { name: "follows", references: { table: "incident" }, onDelete: "setNull", nullable: true },
    );
    incident.indexes = [...incident.indexes!, { name: "by_priority", columns: ["priority"] }];
    extended.tables.push({
      name: "incident_tag",
      siteScoped: true,
      columns: [
        { name: "id", type: "identity" },
        { name: "incident_id", references: { table: "incident" }, onDelete: "cascade" },
        { name: "tag", type: "string", maxLength: 40 },
      ],
      primaryKey: ["id"],
      indexes: [{ name: "by_tag", columns: ["tag"] }],
      constraints: [{ kind: "notEmpty", name: "tag", column: "tag" }],
    });
    return extended;
  }

  it("extends a schema that holds rows with a table, columns, an index and a reference, and keeps the rows", async () => {
    const pool = await requirePhiTestDatabase();
    const site = await createPhiTestSite("addon-extend");
    const { rows: [row] } = await pool.query<{ id: string }>(
      `INSERT INTO "${SCHEMA}".incident (site_id, title, severity, external_ref) VALUES ($1, 'Disk full', 2, 'X-1') RETURNING id`,
      [site.id],
    );

    const extended = extendedDescriptor();
    const outcome = await migratePhisAddon(
      migrationPool,
      { manifest: manifestWith(extended), releaseBuildId: RELEASE, servingRole },
      "a".repeat(64),
    );
    expect(outcome.action).toBe("extended");
    expect(outcome.appliedVersion).toBe(1);
    expect(outcome.statements).toEqual(expect.arrayContaining([
      "create table incident_tag",
      "add column incident.resolution",
      "add column incident.priority",
      "add column incident.follows",
      "point incident.follows at incident within its Site",
      "index incident by priority",
      "index incident_tag by tag",
    ]));
    // A new column comes after the new tables and before the keys that point at it.
    expect(outcome.statements.indexOf("add column incident.follows"))
      .toBeLessThan(outcome.statements.indexOf("point incident.follows at incident within its Site"));

    const { rows: kept } = await pool.query(
      `SELECT title, resolution, priority, follows FROM "${SCHEMA}".incident WHERE id = $1`,
      [row!.id],
    );
    expect(kept).toEqual([{ title: "Disk full", resolution: null, priority: 3, follows: null }]);
    // The serving role may use what was added, as it may use what was there.
    await pool.query(
      `INSERT INTO "${SCHEMA}".incident_tag (site_id, incident_id, tag) VALUES ($1, $2, 'storage')`,
      [site.id, row!.id],
    );
    const { rows: recorded } = await pool.query(
      `SELECT migration_version, checksum FROM phis.server_addon_migrations WHERE addon_id = $1`,
      [ADDON_ID],
    );
    expect(recorded).toEqual([{ migration_version: 1, checksum: digestPhisAddonSchemaDescriptor(extended) }]);

    const again = await migratePhisAddon(
      migrationPool,
      { manifest: manifestWith(extended), releaseBuildId: RELEASE, servingRole },
      "a".repeat(64),
    );
    expect(again.action).toBe("unchanged");
  });

  it("steps to a later version by adding, and refuses to step back", async () => {
    const next = extendedDescriptor();
    next.version = 2;
    next.tables[0]!.columns.push({ name: "acknowledged_at", type: "instant", nullable: true });
    const outcome = await migratePhisAddon(
      migrationPool,
      { manifest: manifestWith(next), releaseBuildId: RELEASE, servingRole },
      "a".repeat(64),
    );
    expect(outcome).toMatchObject({ action: "extended", appliedVersion: 2, statements: ["add column incident.acknowledged_at"] });
    expect(await readCatalog()).toMatchObject({ migration_version: 2 });

    await expect(
      migratePhisAddon(
        migrationPool,
        { manifest: manifestWith(extendedDescriptor()), releaseBuildId: RELEASE, servingRole },
        "a".repeat(64),
      ),
    ).rejects.toThrow(/below the applied 2/);
  });

  it("purges the schema, the records, and the Add-on's secrets", async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.server_secrets (reference, addon_id, ciphertext, iv, auth_tag)
       VALUES ($1, $2, $3, $4, $5)`,
      [`addon:${ADDON_ID}:token`, ADDON_ID, Buffer.from("ab", "hex"), Buffer.alloc(12), Buffer.alloc(16)],
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
    // An account of its own rather than a fixed id: the grant needs a user that exists, and the test
    // database holds whichever ids earlier runs left. `dropPhiTestSites` removes it again afterwards.
    const vendor = await createPhiTestUser(site);
    await pool.query(
      `INSERT INTO phis.site_addon_user_roles (site_id, addon_id, user_id, role, granted_by_user_id)
       VALUES ($1, $2, $3, 'vendor', $3) ON CONFLICT DO NOTHING`,
      [site.id, ADDON_ID, vendor],
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
    const { rows: grants } = await pool.query(
      `SELECT 1 FROM phis.site_addon_user_roles WHERE addon_id = $1 AND user_id = $2`,
      [ADDON_ID, vendor],
    );
    expect(grants).toHaveLength(0);
  });
});
