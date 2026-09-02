import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhiServerAddonSchema, dropPhiServerAddonSchema } from "./server-addon-schema.mts";
import { getPhiServerConfigSync } from "@/lib/config";
import { buildPhiServerAddonAssetsCapability } from "@/lib/addons/assets-capability";
import { ensureSiteMediaSpace, getMediaStorageProfile } from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { readPhiServerAddonStorageUsage } from "./server-addon-storage-usage.mts";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { PhiServerAddonSchemaDescriptor } from "@/lib/addons/contract";

/**
 * Reserving a place for a file and settling it once the bytes are there.
 *
 * The order is the substance. A row exists **before** the transfer, as `pending` with an expiry, and
 * becomes a file only once Core has looked at the object -- so the state that would otherwise be
 * undetectable, a row naming an object that is not there, cannot occur. What an abandoned upload leaves
 * is a pending row past its expiry, which is a `WHERE` rather than a listing of a bucket.
 *
 * The size is agreed before any bytes move, and `finalize` holds the object to it. Discovering the size
 * afterwards would make the ceiling advisory: a client could reserve a kilobyte, deliver a gigabyte, and
 * have the store charged for the kilobyte.
 */

const SCHEMA = "phis_addon_pgtest_assetlife";
const ADDON = "@pgtest/assetlife";

const descriptor: PhiServerAddonSchemaDescriptor = {
  descriptorVersion: 1,
  version: 1,
  tables: [
    {
      name: "offering",
      siteScoped: true,
      columns: [
        { name: "id", type: "identity" },
        { name: "name", type: "string", maxLength: 64 },
      ],
      primaryKey: ["id"],
      assets: [
        { name: "package", cardinality: "one", maxBytes: 4096, contentTypes: ["application/gzip"] },
        { name: "shots", cardinality: "many", maxBytes: 4096, contentTypes: ["image/png"] },
      ],
    },
  ],
};

/** A real gzip header, so the content sniffer has something truthful to agree with. */
const GZIP = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);

let migrationPool: Pool;

describe("putting a file on a row", () => {
  let site: PhiTestSite;
  let offeringId: string;

  function assets(options?: { mayActOnRow?: boolean }) {
    return buildPhiServerAddonAssetsCapability({
      addonId: ADDON,
      siteId: site.id,
      siteKey: site.key,
      schema: descriptor,
      mayActOnRow: async () => options?.mayActOnRow ?? true,
      proxyUploadUrl: ({ table, token }) => `/api/v1/addon-assets/pgtest/assetlife/${table}/${token}`,
    });
  }

  /** What the client would do, standing in for the plan the Provider issued. */
  async function deliver(id: string, body: Buffer) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM ${SCHEMA}.offering_assets WHERE id = $1`,
      [id],
    );
    const { space } = await ensureSiteMediaSpace(site.id);
    const profile = await getMediaStorageProfile(site.id, space.defaultStorageProfileId);
    const service = await createPhisMediaStorageServiceForProfile(profile!, site.key);
    await service.putObject({
      storageKey: rows[0]!.storage_key,
      body,
      contentType: "application/gzip",
    });
  }

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-assetlife");

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
      `INSERT INTO phis.site_server_addons (site_id, addon_id) VALUES ($1, $2)
       ON CONFLICT (site_id, addon_id) DO NOTHING`,
      [site.id, ADDON],
    );
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.offering (site_id, name) VALUES ($1, 'acme') RETURNING id`,
      [site.id],
    );
    offeringId = String(rows[0]!.id);
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    if (migrationPool) {
      const client = await migrationPool.connect();
      try {
        await dropPhiServerAddonSchema(client, SCHEMA);
      } finally {
        client.release();
      }
      await migrationPool.end();
    }
    await pool.query(`DELETE FROM phis.site_server_addons WHERE addon_id = $1`, [ADDON]);
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await closePhiTestPool();
  });

  it("writes the row before the transfer, and does not call it a file yet", async () => {
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: GZIP.byteLength,
    });
    expect(reservation.plan.kind).toBe("proxy-stream");

    // The row is there and the file is not: `list` answers about finished rows only.
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query(
      `SELECT status FROM ${SCHEMA}.offering_assets WHERE id = $1`,
      [reservation.id],
    );
    expect(rows[0]).toMatchObject({ status: 1 });
    expect(await assets().list({ table: "offering", ownerId: offeringId })).toEqual([]);

    await assets().abandon({ table: "offering", id: reservation.id });
  });

  it("charges the store when the place is made, not when it is used", async () => {
    /*
     * Booking on finalize would let a store be filled by uploads that are merely started: the ceiling
     * would hold on paper while the objects accumulated underneath it.
     */
    const pool = await requirePhiTestDatabase();
    const before = await readPhiServerAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: 100,
    });
    const during = await readPhiServerAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    expect(during.bytes).toBe(before.bytes + 100);

    await assets().abandon({ table: "offering", id: reservation.id });
    const after = await readPhiServerAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    expect(after.bytes).toBe(before.bytes);
  });

  it("makes a file of it once the bytes are there", async () => {
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: GZIP.byteLength,
    });
    await deliver(reservation.id, GZIP);
    const asset = await assets().finalize({ table: "offering", id: reservation.id });
    expect(asset).toMatchObject({
      slot: "package",
      byteSize: GZIP.byteLength,
      contentType: "application/gzip",
    });
    expect(await assets().list({ table: "offering", ownerId: offeringId }))
      .toHaveLength(1);

    /*
     * And no object key comes with it. A key an Add-on holds is a key it can pass to `storage:v1`, and
     * the two spaces have to stay apart: the sweep looks under `assets/` and treats everything there
     * that no row names as collectable.
     */
    expect(Object.keys(asset)).not.toContain("storageKey");
    expect(JSON.stringify(asset)).not.toContain("assets/offering");
  });

  it("refuses to finish an upload that never arrived", async () => {
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "shots",
      contentType: "image/png", sizeBytes: 10,
    });
    await expect(assets().finalize({ table: "offering", id: reservation.id }))
      .rejects.toThrow(/Nothing has been delivered/);
    await assets().abandon({ table: "offering", id: reservation.id });
  });

  it("holds the object to the size that was agreed", async () => {
    // Otherwise the ceiling is advisory: reserve a little, deliver a lot, be charged for the little.
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: 4,
    });
    await deliver(reservation.id, GZIP);
    await expect(assets().finalize({ table: "offering", id: reservation.id }))
      .rejects.toThrow(/was made for 4 bytes and 10 arrived/);
    await assets().abandon({ table: "offering", id: reservation.id });
  });

  it("refuses bytes that are not what the slot was told they would be", async () => {
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "shots",
      contentType: "image/png", sizeBytes: GZIP.byteLength,
    });
    // A header is a claim; the first kilobytes are evidence, and these say gzip.
    await deliver(reservation.id, GZIP);
    await expect(assets().finalize({ table: "offering", id: reservation.id }))
      .rejects.toThrow(/the bytes are a "application\/gzip"/);
    await assets().abandon({ table: "offering", id: reservation.id });
  });

  it("replaces a single-valued slot in one step, and gives the old space back", async () => {
    const pool = await requirePhiTestDatabase();
    const before = await readPhiServerAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });

    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: GZIP.byteLength,
    });
    await deliver(reservation.id, GZIP);
    await assets().finalize({ table: "offering", id: reservation.id });

    // Exactly one, and it is the new one: there is no moment at which the row has two packages.
    const held = await assets().list({ table: "offering", ownerId: offeringId, slot: "package" });
    expect(held).toHaveLength(1);
    expect(held[0]!.id).toBe(reservation.id);

    // The replaced file's bytes came back, so replacing does not accumulate.
    const after = await readPhiServerAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    expect(after.bytes).toBe(before.bytes);
  });

  it("lets a slot that accumulates accumulate", async () => {
    const first = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "shots",
      contentType: "image/png", sizeBytes: 3,
    });
    const second = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "shots",
      contentType: "image/png", sizeBytes: 3,
    });
    expect(first.id).not.toBe(second.id);
    await assets().abandon({ table: "offering", id: first.id });
    await assets().abandon({ table: "offering", id: second.id });
  });

  it("refuses a slot the table never declared, and a table with no slots", async () => {
    await expect(assets().begin({
      table: "offering", ownerId: offeringId, slot: "trailer",
      contentType: "application/gzip", sizeBytes: 10,
    })).rejects.toThrow(/declares no asset slot named "trailer"/);
    await expect(assets().begin({
      table: "nothing", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: 10,
    })).rejects.toThrow(/declares no asset slots/);
  });

  it("refuses a type the slot does not take, and a size over its ceiling", async () => {
    await expect(assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "image/png", sizeBytes: 10,
    })).rejects.toThrow(/takes application\/gzip/);
    await expect(assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: 5000,
    })).rejects.toThrow(/takes at most 4096 bytes/);
  });

  it("asks the row's authority, because putting a file on a row changes it", async () => {
    /*
     * Otherwise this would be a second, quieter way past the ladder: a caller who may not edit an
     * offering could still hang a package off it, which is editing it by another name.
     */
    await expect(assets({ mayActOnRow: false }).begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: 10,
    })).rejects.toThrow(/is not this caller's to change/);
  });

  it("takes a file away with its space", async () => {
    const pool = await requirePhiTestDatabase();
    const before = await readPhiServerAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    const held = await assets().list({ table: "offering", ownerId: offeringId, slot: "package" });

    expect(await assets().remove({ table: "offering", id: held[0]!.id })).toBe(true);
    expect(await assets().list({ table: "offering", ownerId: offeringId, slot: "package" }))
      .toEqual([]);
    const after = await readPhiServerAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    expect(after.bytes).toBe(before.bytes - GZIP.byteLength);
  });

});
