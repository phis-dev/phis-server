import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhisAddonSchema, dropPhisAddonSchema } from "./server-addon-schema.mts";
import { getPhisConfigSync } from "@/lib/config";
import { buildPhisAddonCapabilities } from "@/lib/addons/capabilities";
import { ensureAddonMediaSpace, getMediaStorageProfile } from "@/db/media-spaces";
import { getMediaUploadSessionByToken, updateMediaUploadSessionByToken } from "@/db/media";
import { PhiMediaUploadSessionStatus, isPhiMediaUploadBodyProxied } from "@/lib/media-upload-sessions";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { PhisAddonManifestV1 } from "@/lib/addons/contract";

/**
 * Deleting the row a file hangs on.
 *
 * The cascade only ever ran one way. Removing the Add-on's row took its link rows with it -- the
 * foreign key doing its job -- but a Media Asset is not the Add-on's to cascade and no constraint
 * reaches into a store, so the file outlived the link: counted against the Space, pointed at by nothing,
 * and findable only by asking the whole Space which of its files nobody claims.
 *
 * Three things are asserted here, and the third is the one that needed a table. The files go with the
 * row; a delete that is refused takes nothing; and what the store still holds is written down inside the
 * transaction, so the note outlives a process that dies before the object does.
 */

const SCHEMA = "phis_addon_pgtest_rowdelete";
const ADDON = "@pgtest/rowdelete";

/** A real gzip header, so the content sniffer has something truthful to agree with. */
const GZIP = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);

const schema = {
  descriptorVersion: 1 as const,
  version: 1,
  tables: [
    {
      name: "offering",
      siteScoped: true,
      // Owner-scoped so there is a row authority to refuse with: without one the ladder has nothing to
      // judge and every delete is simply the statement.
      ownerScoped: true,
      columns: [
        { name: "id", type: "identity" as const },
        { name: "name", type: "string" as const, maxLength: 64 },
      ],
      primaryKey: ["id"],
      assets: [
        { name: "package", cardinality: "one" as const, maxBytes: 4096, contentTypes: ["application/gzip"] },
      ],
    },
  ],
};

const manifest = {
  manifestVersion: 1,
  addonId: ADDON,
  packageName: ADDON,
  packageVersion: "0.1.0",
  serverAbi: "1",
  capabilities: [],
  serviceProviders: [],
  requiredCoreCapabilities: ["@phis/server/data:v1", "@phis/server/assets:v1"],
  apiRoutes: [],
  hooks: [],
  jobs: [],
  settings: [],
  schema,
  queries: {
    parameters: {
      add: [{ name: "name", type: "text" }],
      drop: [{ name: "id", type: "bigInteger" }],
    },
    queries: [
      {
        kind: "insert",
        name: "add",
        table: "offering",
        values: [{ column: "name", value: { kind: "parameter", name: "name" } }],
      },
      { kind: "delete", name: "drop", table: "offering", idParameter: "id" },
    ],
  },
  migrationVersion: 1,
} as unknown as PhisAddonManifestV1;

let migrationPool: Pool;

describe("deleting a row that holds files", () => {
  let site: PhiTestSite;
  let owner: number;
  let stranger: number;

  function capabilities(actorUserId: number) {
    return buildPhisAddonCapabilities({
      manifest,
      manifestDigest: "pgtest-rowdelete",
      siteId: site.id,
      siteKey: site.key,
      actorUserId,
    });
  }

  /** Puts one file on a row, the way an Add-on would: reserve, deliver, settle. */
  async function attach(actorUserId: number, ownerId: string) {
    const assets = capabilities(actorUserId).assets!;
    const reservation = await assets.begin({
      table: "offering", ownerId, slot: "package",
      contentType: "application/gzip", sizeBytes: GZIP.byteLength,
    });
    const session = await getMediaUploadSessionByToken(reservation.token);
    const space = await ensureAddonMediaSpace(site.id, ADDON);
    const profile = await getMediaStorageProfile(site.id, space.defaultStorageProfileId);
    const service = await createPhisMediaStorageServiceForProfile(profile!, site.key);
    await service.putObject({
      storageKey: session!.stagingStorageKey, body: GZIP, contentType: "application/gzip",
    });
    // What the proxy route records once the body went through Core; finalize refuses a proxied plan
    // without it.
    if (isPhiMediaUploadBodyProxied(session!.uploadPlanKind)) {
      await updateMediaUploadSessionByToken(reservation.token, { status: PhiMediaUploadSessionStatus.Uploaded });
    }
    return await assets.finalize({ table: "offering", token: reservation.token });
  }

  /** Where the store keeps a file, and whether it is still there. */
  async function storageKeyOf(mediaAssetId: number) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM phis.media_assets WHERE site_id = $1 AND id = $2`,
      [site.id, mediaAssetId],
    );
    return rows[0]?.storage_key ?? null;
  }

  async function objectExists(storageKey: string) {
    const space = await ensureAddonMediaSpace(site.id, ADDON);
    const profile = await getMediaStorageProfile(site.id, space.defaultStorageProfileId);
    const service = await createPhisMediaStorageServiceForProfile(profile!, site.key);
    return Boolean(await service.headObject(storageKey));
  }

  async function usedBytes() {
    return (await ensureAddonMediaSpace(site.id, ADDON)).usedBytes;
  }

  async function discardedCount() {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM phis.media_discarded_objects WHERE site_id = $1`,
      [site.id],
    );
    return Number(rows[0]!.total);
  }

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-rowdelete");
    owner = await createPhiTestUser(site);
    stranger = await createPhiTestUser(site);

    const config = getPhisConfigSync().database;
    if (!config?.migrationUri || !config.uri) {
      throw new Error("These tests need database.migrationUri and database.uri.");
    }
    const servingRole = decodeURIComponent(new URL(config.uri).username);
    migrationPool = new Pool({ connectionString: config.migrationUri });
    const client = await migrationPool.connect();
    try {
      await dropPhisAddonSchema(client, SCHEMA);
      await applyPhisAddonSchema(client, { schemaName: SCHEMA, descriptor: schema }, servingRole);
    } finally {
      client.release();
    }

    // The Space names the Add-on, so the Add-on has to be installed before there is one to name.
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
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    if (migrationPool) {
      const client = await migrationPool.connect();
      try {
        await dropPhisAddonSchema(client, SCHEMA);
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

  it("takes the row's files with the row, out of the store as well", async () => {
    const before = await usedBytes();
    const row = await capabilities(owner).data!.insert("add", { name: "acme" });
    const file = await attach(owner, String(row!.id));
    const key = await storageKeyOf(file.mediaAssetId);
    expect(await objectExists(key!)).toBe(true);
    expect(await usedBytes()).toBe(before + GZIP.byteLength);

    const removed = await capabilities(owner).data!.delete("drop", { id: row!.id as number });
    expect(removed).toMatchObject({ name: "acme" });

    // The Asset row, the bytes and the object -- the three that used to come apart from one another.
    const pool = await requirePhiTestDatabase();
    const { rows: assets } = await pool.query(
      `SELECT id FROM phis.media_assets WHERE site_id = $1 AND id = $2`,
      [site.id, file.mediaAssetId],
    );
    expect(assets).toHaveLength(0);
    expect(await usedBytes()).toBe(before);
    expect(await objectExists(key!)).toBe(false);
    // And the note is gone with it: it is a retry list, not a log.
    expect(await discardedCount()).toBe(0);
  });

  it("leaves the files where the delete was refused", async () => {
    /*
     * The reason the files are read before the statement and given up after it. A refused delete comes
     * back as an empty result -- the ladder's silent zero -- and anything that had already removed the
     * files by then would have destroyed them for an act that did not happen.
     */
    const row = await capabilities(owner).data!.insert("add", { name: "not-yours" });
    const file = await attach(owner, String(row!.id));
    const key = await storageKeyOf(file.mediaAssetId);

    expect(await capabilities(stranger).data!.delete("drop", { id: row!.id as number })).toBeNull();

    expect(await capabilities(owner).assets!.list({ table: "offering", ownerId: String(row!.id) }))
      .toHaveLength(1);
    expect(await objectExists(key!)).toBe(true);
  });

  it("deletes a row that holds nothing without going near the store", async () => {
    // The common case, and it must not become more expensive: no links, so nothing to collect, nothing
    // to discard, and no note written.
    const row = await capabilities(owner).data!.insert("add", { name: "bare" });
    expect(await capabilities(owner).data!.delete("drop", { id: row!.id as number }))
      .toMatchObject({ name: "bare" });
    expect(await discardedCount()).toBe(0);
  });
});
