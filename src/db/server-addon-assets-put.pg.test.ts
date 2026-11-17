import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PHIS_ASSET_PUT_MAX_BYTES } from "@phis/contracts/addon";

import { applyPhisAddonSchema, dropPhisAddonSchema } from "./server-addon-schema.mts";
import { getPhisConfigSync } from "@/lib/config";
import { buildPhisAddonAssetsCapability } from "@/lib/addons/assets-capability";
import { ensureAddonMediaSpace, getMediaStorageProfile } from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { PhisAddonSchemaDescriptor } from "@/lib/addons/contract";

/**
 * Putting a file the Add-on already holds into a slot, in one call (`assets:v1` `put`).
 *
 * It is the same slot, the same Space and the same Asset as an upload's, reached without a client: the
 * tests hold it to the rules `begin` and `finalize` hold an upload to, and to the three that are its
 * own -- no actor is needed, the same bytes twice are one file, and the call is capped.
 */

const SCHEMA = "phis_addon_pgtest_assetput";
const ADDON = "@pgtest/assetput";

const descriptor: PhisAddonSchemaDescriptor = {
  descriptorVersion: 1,
  version: 1,
  tables: [
    {
      name: "shop",
      siteScoped: true,
      ownerScoped: true,
      columns: [{ name: "id", type: "identity" }],
      primaryKey: ["id"],
      assets: [
        { name: "cover", cardinality: "one", maxBytes: 4096, contentTypes: ["image/png"], mirrorColumn: "cover_path" },
        { name: "shots", cardinality: "many", maxBytes: 4096, contentTypes: ["image/png"] },
        { name: "package", cardinality: "one", maxBytes: 4096, contentTypes: ["application/gzip"] },
        { name: "big", cardinality: "one", maxBytes: 64 * 1024 * 1024, contentTypes: ["image/png"] },
      ],
    },
  ],
};

const png = (red: number) =>
  sharp({ create: { width: 3, height: 2, channels: 3, background: { r: red, g: 0, b: 0 } } }).png().toBuffer();

let migrationPool: Pool;

describe("putting bytes the Add-on holds", () => {
  let site: PhiTestSite;
  let shopId: string;
  let otherShopId: string;
  let actor: number;

  function assets(options: { actorUserId?: number | null; mayActOnRow?: boolean; announces?: boolean } = {}) {
    return buildPhisAddonAssetsCapability({
      addonId: ADDON,
      siteId: site.id,
      siteKey: site.key,
      actorUserId: "actorUserId" in options ? (options.actorUserId ?? null) : null,
      schema: descriptor,
      mayActOnRow: async () => options.mayActOnRow ?? true,
      hasRole: async () => false,
      proxyUploadUrl: ({ token }) => `/api/site/media/uploads/${token}`,
      announcesChanges: options.announces ?? false,
    });
  }

  async function space() {
    return ensureAddonMediaSpace(site.id, ADDON);
  }

  async function assetRow(mediaAssetId: number) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{
      created_by_user_id: number | null; owner_user_id: number | null; meta: Record<string, unknown> | null;
      width: number | null; height: number | null; checksum_algorithm: string | null; lifecycle_status: number;
      delivery_policy: number; storage_key: string; storage_profile_id: number;
    }>(`SELECT * FROM phis.media_assets WHERE id = $1`, [mediaAssetId]);
    return rows[0] ?? null;
  }

  async function objectExists(mediaAssetId: number) {
    const row = (await assetRow(mediaAssetId))!;
    const profile = await getMediaStorageProfile(site.id, row.storage_profile_id);
    const service = await createPhisMediaStorageServiceForProfile(profile!, site.key);
    return Boolean(await service.headObject(row.storage_key));
  }

  async function events() {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query(
      `SELECT id FROM phis.addon_event_outbox WHERE site_id = $1 AND event = 'asset.changed'`, [site.id],
    );
    return rows.length;
  }

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-assetput");
    actor = await createPhiTestUser(site);
    const config = getPhisConfigSync().database;
    if (!config?.migrationUri || !config.uri) throw new Error("These tests need database.migrationUri and database.uri.");
    const servingRole = decodeURIComponent(new URL(config.uri).username);
    migrationPool = new Pool({ connectionString: config.migrationUri });
    const client = await migrationPool.connect();
    try {
      await dropPhisAddonSchema(client, SCHEMA);
      await applyPhisAddonSchema(client, { schemaName: SCHEMA, descriptor }, servingRole);
    } finally {
      client.release();
    }
    await pool.query(
      `INSERT INTO phis.server_addons (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
       VALUES ($1, $1, '0.1.0', '1', repeat('0', 64), 'pgtest') ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON],
    );
    await pool.query(
      `INSERT INTO phis.site_server_addons (site_id, addon_id, flags, configuration_status) VALUES ($1, $2, 1, 'ready')
       ON CONFLICT (site_id, addon_id) DO NOTHING`,
      [site.id, ADDON],
    );
    for (const name of ["shopId", "otherShopId"] as const) {
      const { rows } = await pool.query<{ id: string }>(`INSERT INTO ${SCHEMA}.shop (site_id) VALUES ($1) RETURNING id`, [site.id]);
      if (name === "shopId") shopId = String(rows[0]!.id); else otherShopId = String(rows[0]!.id);
    }
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    if (migrationPool) {
      const client = await migrationPool.connect();
      try { await dropPhisAddonSchema(client, SCHEMA); } finally { client.release(); }
      await migrationPool.end();
    }
    await pool.query(`DELETE FROM phis.site_server_addons WHERE addon_id = $1`, [ADDON]);
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await closePhiTestPool();
  });

  it("stores the file with no actor, as the Add-on's own, in its Space, and mirrors the path", async () => {
    const bytes = await png(10);
    const view = await assets({ announces: true }).put({
      table: "shop", ownerId: shopId, slot: "cover", contentType: "image/png", bytes, fileName: "cover.png",
    });
    expect(view).toMatchObject({ slot: "cover", ownerId: shopId, contentType: "image/png", byteSize: bytes.byteLength });
    expect(view.contentPath).toMatch(/\?r=1$|\/\d+/u);
    const row = (await assetRow(view.mediaAssetId))!;
    expect(row).toMatchObject({
      created_by_user_id: null, owner_user_id: null, meta: { source: "addon", addonId: ADDON },
      width: 3, height: 2, checksum_algorithm: "sha256", lifecycle_status: 2, delivery_policy: 1,
    });
    expect(await objectExists(view.mediaAssetId)).toBe(true);
    expect((await space()).usedBytes).toBe(bytes.byteLength);
    expect((await space()).reservedBytes).toBe(0);
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query(`SELECT cover_path FROM ${SCHEMA}.shop WHERE id = $1`, [shopId]);
    expect(rows[0].cover_path).toBe(view.contentPath);
    expect(await events()).toBe(1);
    expect(await assets().list({ table: "shop", ownerId: shopId, slot: "cover" })).toEqual([view]);
  });

  it("answers the same bytes in the same slot with the file there, and changes nothing", async () => {
    const before = { used: (await space()).usedBytes, events: await events() };
    const bytes = await png(10);
    const first = (await assets().list({ table: "shop", ownerId: shopId, slot: "cover" }))[0]!;
    const again = await assets({ announces: true }).put({ table: "shop", ownerId: shopId, slot: "cover", contentType: "image/png", bytes });
    expect(again).toEqual(first);
    expect((await space()).usedBytes).toBe(before.used);
    expect(await events()).toBe(before.events);
  });

  it("refuses the same bytes for another row or slot, naming the Asset, as finalize does", async () => {
    const bytes = await png(10);
    const first = (await assets().list({ table: "shop", ownerId: shopId, slot: "cover" }))[0]!;
    await expect(assets().put({ table: "shop", ownerId: otherShopId, slot: "cover", contentType: "image/png", bytes }))
      .rejects.toThrow(new RegExp(`as Asset ${first.mediaAssetId},? `, "u"));
    await expect(assets().put({ table: "shop", ownerId: shopId, slot: "shots", contentType: "image/png", bytes }))
      .rejects.toThrow(/already stored/u);
  });

  it("replaces what a single slot holds, takes the old file and its bytes away, and adds to a many slot", async () => {
    const old = (await assets().list({ table: "shop", ownerId: shopId, slot: "cover" }))[0]!;
    const usedBefore = (await space()).usedBytes;
    const bytes = await png(200);
    const next = await assets({ announces: true }).put({ table: "shop", ownerId: shopId, slot: "cover", contentType: "image/png", bytes });
    expect(next.mediaAssetId).not.toBe(old.mediaAssetId);
    expect(await assetRow(old.mediaAssetId)).toBeNull();
    expect(await objectExists(next.mediaAssetId)).toBe(true);
    expect((await space()).usedBytes).toBe(usedBefore - old.byteSize + bytes.byteLength);
    expect(await assets().list({ table: "shop", ownerId: shopId, slot: "cover" })).toHaveLength(1);

    await assets().put({ table: "shop", ownerId: shopId, slot: "shots", contentType: "image/png", bytes: await png(50) });
    await assets().put({ table: "shop", ownerId: shopId, slot: "shots", contentType: "image/png", bytes: await png(60) });
    expect(await assets().list({ table: "shop", ownerId: shopId, slot: "shots" })).toHaveLength(2);
  });

  it("holds the bytes to the slot: the declared type, the signature, the slot's size, the hard cap", async () => {
    const bytes = await png(70);
    await expect(assets().put({ table: "shop", ownerId: shopId, slot: "cover", contentType: "image/jpeg", bytes }))
      .rejects.toThrow(/takes image\/png/u);
    // PNG bytes presented as the package the slot takes.
    await expect(assets().put({ table: "shop", ownerId: shopId, slot: "package", contentType: "application/gzip", bytes }))
      .rejects.toThrow(/the bytes are a "image\/png"/u);
    await expect(assets().put({ table: "shop", ownerId: shopId, slot: "cover", contentType: "image/png", bytes: Buffer.alloc(5000) }))
      .rejects.toThrow(/at most 4096/u);
    await expect(assets().put({ table: "shop", ownerId: shopId, slot: "cover", contentType: "image/png", bytes: new Uint8Array(0) }))
      .rejects.toThrow(/at least one byte/u);
    await expect(assets().put({ table: "shop", ownerId: shopId, slot: "big", contentType: "image/png", bytes: new Uint8Array(PHIS_ASSET_PUT_MAX_BYTES + 1) }))
      .rejects.toThrow(/begin and finalize/u);
    await expect(assets().put({ table: "shop", ownerId: shopId, slot: "nowhere", contentType: "image/png", bytes }))
      .rejects.toThrow(/declares no asset slot/u);
    await expect(assets().put({ table: "shop", ownerId: shopId, slot: "cover", contentType: "image/png", bytes: "text" as never }))
      .rejects.toThrow(/Uint8Array/u);
  });

  it("is refused a row it may not change, with or without an actor, and a row that is not there", async () => {
    const bytes = await png(80);
    await expect(assets({ actorUserId: actor, mayActOnRow: false }).put({ table: "shop", ownerId: shopId, slot: "shots", contentType: "image/png", bytes }))
      .rejects.toThrow(/not this caller's to change/u);
    await expect(assets({ actorUserId: null, mayActOnRow: false }).put({ table: "shop", ownerId: shopId, slot: "shots", contentType: "image/png", bytes }))
      .rejects.toThrow(/not this caller's to change/u);
    await expect(assets().put({ table: "shop", ownerId: "999999999", slot: "shots", contentType: "image/png", bytes }))
      .rejects.toThrow(/does not exist/u);
    await expect(assets().put({ table: "shop", ownerId: "not-a-number", slot: "shots", contentType: "image/png", bytes }))
      .rejects.toThrow(/does not exist/u);
    // With an actor who may change the row it is stored, and still no user is its creator.
    const view = await assets({ actorUserId: actor }).put({ table: "shop", ownerId: shopId, slot: "shots", contentType: "image/png", bytes });
    expect((await assetRow(view.mediaAssetId))).toMatchObject({ created_by_user_id: null });
  });

  it("charges the Add-on's Space and refuses past its ceiling without leaving a charge or an object", async () => {
    const pool = await requirePhiTestDatabase();
    const current = await space();
    const bytes = await png(90);
    await pool.query(`UPDATE phis.media_spaces SET quota_bytes = $2 WHERE id = $1`, [current.id, current.usedBytes + bytes.byteLength - 1]);
    const before = await space();
    await expect(assets().put({ table: "shop", ownerId: shopId, slot: "shots", contentType: "image/png", bytes }))
      .rejects.toThrow(/no room/u);
    const after = await space();
    expect({ used: after.usedBytes, reserved: after.reservedBytes }).toEqual({ used: before.usedBytes, reserved: before.reservedBytes });
    await pool.query(`UPDATE phis.media_spaces SET quota_bytes = NULL WHERE id = $1`, [current.id]);
    await assets().put({ table: "shop", ownerId: shopId, slot: "shots", contentType: "image/png", bytes });
    expect((await space()).usedBytes).toBe(before.usedBytes + bytes.byteLength);
  });
});
