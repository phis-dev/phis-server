import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyPhisAddonSchema,
  dropPhisAddonSchema,
  verifyPhisAddonSchema,
} from "./server-addon-schema.mts";
import { getPhisConfigSync } from "@/lib/config";
import { quotePhiIdentifier } from "@/lib/addons/schema-ddl";
import { incidentSchemaDescriptor } from "../../test/fixtures/addon-schema.ts";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * What only PostgreSQL can answer about a generated schema: whether the cascade really cascades,
 * whether the serving role can read what the migration role just created, and whether the check after
 * the fact sees what the contract says it must.
 */

const SCHEMA = "phis_addon_pgtest_incidents";
const FOREIGN_SCHEMA = "pgtest_pretend_core";
const target = { schemaName: SCHEMA, descriptor: incidentSchemaDescriptor };

let migrationPool: Pool;
let servingRole: string;

async function withMigrationClient<T>(run: (client: import("pg").PoolClient) => Promise<T>) {
  const client = await migrationPool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

describe("generated Add-on schema", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-schema");
    const config = getPhisConfigSync().database;
    if (!config?.migrationUri || !config.uri) {
      throw new Error("These tests need database.migrationUri and database.uri.");
    }
    servingRole = decodeURIComponent(new URL(config.uri).username);
    migrationPool = new Pool({ connectionString: config.migrationUri });
    await withMigrationClient(async (client) => {
      await dropPhisAddonSchema(client, SCHEMA);
      await client.query(`DROP SCHEMA IF EXISTS ${quotePhiIdentifier(FOREIGN_SCHEMA)} CASCADE`);
      await applyPhisAddonSchema(client, target, servingRole);
    });
  });

  afterAll(async () => {
    if (migrationPool) {
      await withMigrationClient(async (client) => {
        await client.query(`DROP SCHEMA IF EXISTS ${quotePhiIdentifier(FOREIGN_SCHEMA)} CASCADE`);
        await dropPhisAddonSchema(client, SCHEMA);
      });
      await migrationPool.end();
    }
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("passes its own verification", async () => {
    const issues = await withMigrationClient((client) => verifyPhisAddonSchema(client, target));
    expect(issues).toEqual([]);
  });

  it("lets the serving role read what the migration role created", async () => {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total FROM ${quotePhiIdentifier(SCHEMA)}."incident"`,
    );
    expect(rows[0].total).toBe(0);
  });

  it("refuses DDL from the serving role", async () => {
    const pool = await requirePhiTestDatabase();
    await expect(
      pool.query(`CREATE TABLE ${quotePhiIdentifier(SCHEMA)}."smuggled" (id INT)`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("takes an Add-on's rows with the Site they belong to", async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."incident"
         (site_id, title, state, severity, external_ref)
       VALUES ($1, 'disk full', 'open', 3, 'ext-1')`,
      [site.id],
    );
    const before = await pool.query(
      `SELECT count(*)::int AS total FROM ${quotePhiIdentifier(SCHEMA)}."incident"`,
    );
    expect(before.rows[0].total).toBe(1);

    await pool.query(`DELETE FROM phis.sites WHERE id = $1`, [site.id]);
    const after = await pool.query(
      `SELECT count(*)::int AS total FROM ${quotePhiIdentifier(SCHEMA)}."incident"`,
    );
    expect(after.rows[0].total).toBe(0);

    site = await createPhiTestSite("addon-schema");
  });

  it("enforces the structured constraints it was given", async () => {
    const pool = await requirePhiTestDatabase();
    const insert = (severity: number, external: string | null, internal: string | null) =>
      pool.query(
        `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."incident"
           (site_id, title, state, severity, external_ref, internal_ref)
         VALUES ($1, 'x', 'open', $2, $3, $4)`,
        [site.id, severity, external, internal],
      );
    await expect(insert(9, "e", null)).rejects.toThrow(/incident_severity_check/);
    await expect(insert(1, "e", "i")).rejects.toThrow(/incident_one_reference_check/);
    await expect(
      pool.query(
        `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."incident"
           (site_id, title, state, severity, external_ref)
         VALUES ($1, '   ', 'open', 1, 'e')`,
        [site.id],
      ),
    ).rejects.toThrow(/incident_title_check/);
  });

  it("reports a foreign key that points into the Add-on from outside", async () => {
    const issues = await withMigrationClient(async (client) => {
      await client.query(`CREATE SCHEMA ${quotePhiIdentifier(FOREIGN_SCHEMA)}`);
      await client.query(
        `CREATE TABLE ${quotePhiIdentifier(FOREIGN_SCHEMA)}."pretend" (
           id INT PRIMARY KEY,
           incident_id BIGINT NOT NULL
             REFERENCES ${quotePhiIdentifier(SCHEMA)}."incident"(id) ON DELETE CASCADE
         )`,
      );
      const found = await verifyPhisAddonSchema(client, target);
      await client.query(`DROP SCHEMA ${quotePhiIdentifier(FOREIGN_SCHEMA)} CASCADE`);
      return found;
    });
    expect(issues.join("\n")).toMatch(/never depends on something an operator may uninstall/);
  });

  it("reports a table nobody declared", async () => {
    const issues = await withMigrationClient(async (client) => {
      await client.query(`CREATE TABLE ${quotePhiIdentifier(SCHEMA)}."stray" (id INT PRIMARY KEY)`);
      const found = await verifyPhisAddonSchema(client, target);
      await client.query(`DROP TABLE ${quotePhiIdentifier(SCHEMA)}."stray"`);
      return found;
    });
    expect(issues.join("\n")).toMatch(/without being declared/);
  });

  it("does not call the link table of a slot a stray", async () => {
    /*
     * The table nobody declares and Core writes anyway.
     *
     * A table with asset slots gets a link table generated beside it, and the check reads back what is
     * in the schema. Counting only the descriptor's own names made the runner complain about the table
     * it had just created one statement earlier -- so no Add-on with slots could be migrated at all,
     * which is how this was found.
     */
    const slotted = "phis_addon_pgtest_slots";
    const withSlots = {
      schemaName: slotted,
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
              { name: "icon", cardinality: "one" as const, maxBytes: 4096, contentTypes: ["image/png"] },
            ],
          },
        ],
      },
    };
    const issues = await withMigrationClient(async (client) => {
      await dropPhisAddonSchema(client, slotted);
      await applyPhisAddonSchema(client, withSlots, servingRole);
      const found = await verifyPhisAddonSchema(client, withSlots);
      await dropPhisAddonSchema(client, slotted);
      return found;
    });
    expect(issues).toEqual([]);
  });

  it("removes everything when the schema is dropped", async () => {
    await withMigrationClient(async (client) => {
      await dropPhisAddonSchema(client, SCHEMA);
      const { rows } = await client.query(
        `SELECT count(*)::int AS total FROM information_schema.tables WHERE table_schema = $1`,
        [SCHEMA],
      );
      expect(rows[0].total).toBe(0);
      await applyPhisAddonSchema(client, target, servingRole);
    });
  });
});
