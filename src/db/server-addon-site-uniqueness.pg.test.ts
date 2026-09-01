import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyPhiServerAddonSchema,
  dropPhiServerAddonSchema,
} from "./server-addon-schema.mts";
import { getPhiServerConfigSync } from "@/lib/config";
import { quotePhiIdentifier } from "@/lib/addons/schema-ddl";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * What "unique" means in a table that holds rows for several Sites.
 *
 * Only PostgreSQL can answer this. The Add-on cannot declare `site_id`, so it can neither name it in an
 * index nor write the pair, and a descriptor that says `unique` reads the same either way. What decides
 * is what Core generated: plain uniqueness would let the second Site to install the Add-on collide with
 * the first over a value neither of them can see, and the failure would surface as a constraint
 * violation on somebody else's row.
 */

const SCHEMA = "phis_addon_pgtest_offerings";
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
          { name: "slug", type: "string" as const, maxLength: 64, unique: true },
          { name: "external_ref", type: "string" as const, maxLength: 64 },
        ],
        primaryKey: ["id"],
        indexes: [{ name: "by_external", columns: ["external_ref"], unique: true }],
      },
    ],
  },
};

let migrationPool: Pool;

describe("uniqueness in a Site-scoped Add-on table", () => {
  let site: PhiTestSite;
  let otherSite: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-unique");
    otherSite = await createPhiTestSite("addon-unique-other");

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

  async function insertOffering(siteId: number, slug: string, externalRef: string) {
    const pool = await requirePhiTestDatabase();
    return pool.query(
      `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."offering" (site_id, slug, external_ref)
       VALUES ($1, $2, $3)`,
      [siteId, slug, externalRef],
    );
  }

  it("lets two Sites hold the same value, because neither can see the other's", async () => {
    await insertOffering(site.id, "crm", "ref-1");
    await expect(insertOffering(otherSite.id, "crm", "ref-1")).resolves.toBeDefined();
  });

  it("still refuses a duplicate inside one Site", async () => {
    await insertOffering(site.id, "billing", "ref-2");
    await expect(insertOffering(site.id, "billing", "ref-3")).rejects.toThrow(
      /offering_slug_uq|duplicate key/,
    );
  });

  it("reads a unique index the same way as a unique column", async () => {
    await insertOffering(site.id, "helpdesk", "ref-shared");
    await expect(insertOffering(otherSite.id, "helpdesk-other", "ref-shared")).resolves.toBeDefined();
    await expect(insertOffering(site.id, "helpdesk-two", "ref-shared")).rejects.toThrow(
      /offering_by_external_idx|duplicate key/,
    );
  });
});
