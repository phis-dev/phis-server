import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhiServerAddonSchema, dropPhiServerAddonSchema } from "./server-addon-schema.mts";
import { getPhiServerConfigSync } from "@/lib/config";
import {
  phiServerAddonLocalObjectAdapter,
  readPhiServerAddonAssetTables,
  sweepPhiServerAddonAssets,
} from "../cli/storage-sweep.mts";
import { readPhiServerAddonStorageUsage } from "./server-addon-storage-usage.mts";
import { phiServerAddonStoragePrefix } from "@/lib/addons/schema-name";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { PhiServerAddonSchemaDescriptor } from "@/lib/addons/contract";
import type { PhiServerAddonStorageSite } from "../cli/storage-purge.mts";

/**
 * Collecting what an Add-on's asset store no longer refers to.
 *
 * Two leftovers, from two causes that both come down to the store not being in the transaction. A parent
 * row removed takes its asset rows through the cascade, and the cascade is SQL: it cannot reach into a
 * bucket, so the objects outlive the rows by design. And a reservation charged for bytes that never
 * arrived holds space nobody is using.
 *
 * The one thing this must never do is delete something live. The sweep looks under `assets/` and nowhere
 * else, because the free key space `storage:v1` hands out has no row describing it -- a sweep that saw
 * both would read every one of those objects as an orphan.
 */

const SCHEMA = "phis_addon_pgtest_sweep";
const ADDON = "@pgtest/sweep";

const descriptor: PhiServerAddonSchemaDescriptor = {
  descriptorVersion: 1,
  version: 1,
  tables: [
    {
      name: "offering",
      siteScoped: true,
      columns: [{ name: "id", type: "identity" }, { name: "name", type: "string", maxLength: 32 }],
      primaryKey: ["id"],
      assets: [
        { name: "package", cardinality: "one", maxBytes: 4096, contentTypes: ["application/gzip"] },
      ],
    },
    {
      // Declares nothing, so Core adds no table beside it -- and the sweep must not invent one.
      name: "category",
      siteScoped: true,
      columns: [{ name: "id", type: "identity" }, { name: "label", type: "string", maxLength: 32 }],
      primaryKey: ["id"],
    },
  ],
};

let migrationPool: Pool;

describe("sweeping an Add-on's asset store", () => {
  let site: PhiTestSite;
  let root: string;
  let offeringId: string;
  let prefix: string;

  function store(): PhiServerAddonStorageSite {
    return {
      siteId: site.id, siteKey: site.key,
      providerId: "@phis/server/storage-local",
      config: { rootDir: root }, secretReference: null,
    };
  }

  function sweep() {
    return sweepPhiServerAddonAssets(pool!, {
      addonId: ADDON, site: store(), adapter: phiServerAddonLocalObjectAdapter(root),
    });
  }

  let pool: Pool | null = null;

  /** Writes an object at a key, the way a completed transfer would have left one. */
  async function place(storageKey: string, body: string) {
    const file = path.join(root, storageKey);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async function writeRow(input: {
    slot: string; status: number; key: string; bytes: number; expiresAt?: string | null;
  }) {
    const { rows } = await pool!.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.offering_assets
         (site_id, owner_id, slot, status, storage_key, byte_size, content_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'application/gzip', $7)
       RETURNING id`,
      [site.id, offeringId, input.slot, input.status, input.key, input.bytes,
       input.expiresAt === undefined ? null : input.expiresAt],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-asset-sweep");
    root = await mkdtemp(path.join(tmpdir(), "phis-sweep-"));
    prefix = phiServerAddonStoragePrefix(ADDON, site.key);

    const config = getPhiServerConfigSync().database;
    if (!config?.migrationUri || !config.uri) {
      throw new Error("These tests need database.migrationUri and database.uri.");
    }
    const servingRole = decodeURIComponent(new URL(config.uri).username);
    migrationPool = new Pool({ connectionString: config.migrationUri });
    const client = await migrationPool.connect();
    try {
      await dropPhiServerAddonSchema(client, SCHEMA);
      await applyPhiServerAddonSchema(client, { schemaName: SCHEMA, descriptor }, servingRole);
    } finally {
      client.release();
    }

    await pool.query(
      `INSERT INTO phis.server_addons
         (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
       VALUES ($1, $1, '0.1.0', '1', repeat('0', 64), 'pgtest')
       ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON],
    );
    await pool.query(
      `INSERT INTO phis.site_server_addons
         (site_id, addon_id, storage_used_bytes, storage_used_objects)
       VALUES ($1, $2, 1000, 10) ON CONFLICT (site_id, addon_id) DO NOTHING`,
      [site.id, ADDON],
    );
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.offering (site_id, name) VALUES ($1, 'acme') RETURNING id`,
      [site.id],
    );
    offeringId = String(rows[0]!.id);
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
    await rm(root, { recursive: true, force: true });
    await pool!.query(`DELETE FROM phis.site_server_addons WHERE addon_id = $1`, [ADDON]);
    await dropPhiTestSites();
    await pool!.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await closePhiTestPool();
  });

  it("finds the derived tables by their shape, not by their name", async () => {
    /*
     * A declared table may legitimately be called `foo_assets` where `foo` declares nothing. What marks
     * a derived one is that it holds both `storage_key` and `upload_token` -- columns no descriptor can
     * produce, because they are Core's.
     */
    const found = await readPhiServerAddonAssetTables(pool!, ADDON);
    expect(found.tables).toEqual(["offering_assets"]);
  });

  it("leaves a finished file alone", async () => {
    const key = `${prefix}/assets/offering/package/kept`;
    await place(key, "hello");
    await writeRow({ slot: "package", status: 2, key, bytes: 5 });

    const result = await sweep();
    expect(result).toMatchObject({ expired: 0, orphaned: 0, error: null });
    // Still there, and still named.
    expect((await phiServerAddonLocalObjectAdapter(root).listPrefix(`${prefix}/assets`)).map((h) => h.storageKey))
      .toContain(key);
  });

  it("never touches the free key space an Add-on manages itself", async () => {
    /*
     * The boundary the whole file rests on. Objects an Add-on wrote through `storage:v1` have no row
     * describing them, so a sweep that looked outside `assets/` would read every one of them as an
     * orphan and delete live data that was never a mistake.
     */
    const own = `${prefix}/exports/report.csv`;
    await place(own, "a,b,c");

    await sweep();
    expect((await phiServerAddonLocalObjectAdapter(root).listPrefix(prefix)).map((h) => h.storageKey))
      .toContain(own);
  });

  it("collects an object no row names, and gives its space back", async () => {
    // What a cascade leaves: the parent row went, its asset rows went with it, and the object could not.
    const orphan = `${prefix}/assets/offering/package/orphaned`;
    await place(orphan, "0123456789");
    const before = await readPhiServerAddonStorageUsage(pool!, { addonId: ADDON, siteId: site.id });

    const result = await sweep();
    expect(result).toMatchObject({ orphaned: 1, bytesReleased: 10, error: null });

    const after = await readPhiServerAddonStorageUsage(pool!, { addonId: ADDON, siteId: site.id });
    expect(after.bytes).toBe(before.bytes - 10);
    expect(after.objects).toBe(before.objects - 1);
  });

  it("removes a reservation that ran out, together with whatever arrived for it", async () => {
    const key = `${prefix}/assets/offering/package/expired`;
    await place(key, "partial");
    const id = await writeRow({
      slot: "package", status: 1, key, bytes: 7,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const before = await readPhiServerAddonStorageUsage(pool!, { addonId: ADDON, siteId: site.id });

    const result = await sweep();
    expect(result).toMatchObject({ expired: 1, orphaned: 0, error: null });

    const { rows } = await pool!.query(
      `SELECT id FROM ${SCHEMA}.offering_assets WHERE id = $1`, [id],
    );
    expect(rows).toHaveLength(0);
    const after = await readPhiServerAddonStorageUsage(pool!, { addonId: ADDON, siteId: site.id });
    expect(after.bytes).toBe(before.bytes - 7);
  });

  it("leaves a reservation that is still open, and the transfer running into it", async () => {
    /*
     * The row always exists before its object does -- that is what `begin` is for -- so a transfer in
     * flight is named by a row and cannot be read as an orphan. This is the case that would otherwise
     * delete a large upload halfway through it.
     */
    const key = `${prefix}/assets/offering/package/inflight`;
    await place(key, "half");
    const id = await writeRow({
      slot: "package", status: 1, key, bytes: 40,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await sweep();
    expect(result).toMatchObject({ expired: 0, orphaned: 0 });
    const { rows } = await pool!.query(
      `SELECT id FROM ${SCHEMA}.offering_assets WHERE id = $1`, [id],
    );
    expect(rows).toHaveLength(1);
  });

  it("does nothing on a Site whose store was never written to", async () => {
    const other = await createPhiTestSite("addon-asset-sweep-b");
    const result = await sweepPhiServerAddonAssets(pool!, {
      addonId: ADDON,
      site: { ...store(), siteId: other.id, siteKey: other.key },
      adapter: phiServerAddonLocalObjectAdapter(root),
    });
    expect(result).toMatchObject({ expired: 0, orphaned: 0, bytesReleased: 0, error: null });
  });
});
