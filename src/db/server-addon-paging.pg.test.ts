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
 * Whether paging actually holds, which only PostgreSQL can say.
 *
 * The case worth the database is rows that share a sort value. Ordered by `updated_at` alone, the
 * server may return them in either order, and a page boundary falling between two of them lands
 * differently on each call -- one row on two pages, another on none. Nothing raises, nothing logs, and
 * the caller has no way to tell. Core finishing the order with the primary key is what removes that,
 * and this is where it is demonstrated rather than argued.
 */

const SCHEMA = "phis_addon_pgtest_paging";
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
          { name: "kind", type: "string" as const, maxLength: 64 },
          { name: "updated_at", type: "instant" as const },
        ],
        primaryKey: ["id"],
      },
    ],
  },
};

const manifest = {
  manifestVersion: 1,
  addonId: "@pgtest/paging",
  packageName: "@pgtest/paging",
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
      listing: [{ name: "kind", type: "text", nullable: true }],
      by_title: [],
    },
    queries: [
      {
        kind: "select",
        name: "listing",
        table: "offering",
        columns: ["id", "title", "updated_at"],
        where: {
          kind: "whenPresent",
          parameter: "kind",
          condition: {
            kind: "compare",
            column: "kind",
            operator: "=",
            value: { kind: "parameter", name: "kind" },
          },
        },
        // Every row carries the same instant on purpose: the tie is the point.
        orderBy: [{ column: "updated_at", direction: "desc" }],
        limit: 25,
      },
      {
        kind: "select",
        name: "by_title",
        table: "offering",
        orderBy: [{ column: "title", direction: "asc" }],
        limit: 25,
      },
    ],
  },
  migrationVersion: 1,
} as unknown as PhiServerAddonManifestV1;

let migrationPool: Pool;

describe("paging a declared select", () => {
  let site: PhiTestSite;

  function data() {
    return buildPhiServerAddonCapabilities({
      manifest,
      manifestDigest: "pgtest-paging",
      siteId: site.id,
      actorUserId: null,
    }).data!;
  }

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-paging");

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
    for (const index of [1, 2, 3, 4, 5, 6, 7]) {
      await pool.query(
        `INSERT INTO ${quotePhiIdentifier(SCHEMA)}."offering" (site_id, title, kind, updated_at)
         VALUES ($1, $2, $3, '2026-08-30T10:00:00Z')`,
        [site.id, `row-${index}`, index % 2 === 0 ? "module" : "addon"],
      );
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

  async function readAll(name: string, args: Record<string, string | null>, size: number) {
    const titles: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { rows: readonly { title?: unknown }[]; cursor: string | null } =
        await data().select(name, args, { limit: size, cursor });
      titles.push(...page.rows.map((row) => String(row.title)));
      cursor = page.cursor;
      pages += 1;
      if (pages > 20) {
        throw new Error("Paging did not terminate.");
      }
    } while (cursor);
    return { titles, pages };
  }

  it("walks every row exactly once, although they all share a sort value", async () => {
    const { titles, pages } = await readAll("by_title", {}, 2);
    expect(titles).toEqual(["row-1", "row-2", "row-3", "row-4", "row-5", "row-6", "row-7"]);
    expect(new Set(titles).size).toBe(titles.length);
    expect(pages).toBe(4);
  });

  it("holds when the ordering column is the same instant in every row", async () => {
    const { titles } = await readAll("listing", { kind: null }, 3);
    expect(new Set(titles).size).toBe(7);
  });

  it("hands back a cursor while there is more, and none on the last page", async () => {
    const first = await data().select("by_title", {}, { limit: 5 });
    expect(first.rows).toHaveLength(5);
    expect(first.cursor).not.toBeNull();

    const second = await data().select("by_title", {}, { limit: 5, cursor: first.cursor });
    expect(second.rows).toHaveLength(2);
    expect(second.cursor).toBeNull();
  });

  it("filters when the parameter is given and does not when it is null", async () => {
    const filtered = await data().select("listing", { kind: "module" }, { limit: 25 });
    expect(filtered.rows).toHaveLength(3);
    const unfiltered = await data().select("listing", { kind: null }, { limit: 25 });
    expect(unfiltered.rows).toHaveLength(7);
  });

  it("narrows a page size beyond the Add-on's own ceiling instead of honouring it", async () => {
    const page = await data().select("by_title", {}, { limit: 1000 });
    expect(page.rows).toHaveLength(7);
  });

  it("refuses a cursor from a different query rather than paging on a foreign order", async () => {
    const first = await data().select("by_title", {}, { limit: 2 });
    await expect(data().select("listing", { kind: null }, { cursor: first.cursor }))
      .rejects.toThrow(/different ordering/);
  });
});
