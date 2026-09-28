import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhisAddonSchema, dropPhisAddonSchema } from "./server-addon-schema.mts";
import { getPhisConfigSync } from "@/lib/config";
import { buildPhisAddonAssetsCapability } from "@/lib/addons/assets-capability";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { ensureAddonMediaSpace } from "@/db/media-spaces";
import { getMediaUploadSessionByToken, releaseExpiredMediaUploadSessions } from "@/db/media";
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
 * Reserving a place for a file and settling it once the bytes are there.
 *
 * There is one upload lifecycle in Core and this is not a second one. The reservation is an ordinary
 * Media upload session that states its purpose; what makes it an Add-on's file is the last step, where
 * the finished object becomes a Media Asset in the Add-on's own Space and a link row on its table.
 *
 * Two things carry the design. The space is charged when the place is made, not when it is used -- a
 * ceiling decided at the end would bound the bookkeeping and not the store. And the size is agreed
 * before any bytes move, so `finalize` can hold the object to it rather than discover it.
 */

const SCHEMA = "phis_addon_pgtest_assetlife";
const ADDON = "@pgtest/assetlife";

const descriptor: PhisAddonSchemaDescriptor = {
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
        {
          name: "package",
          cardinality: "one",
          maxBytes: 4096,
          contentTypes: ["application/gzip"],
          mirrorColumn: "package_path",
        },
        { name: "shots", cardinality: "many", maxBytes: 4096, contentTypes: ["image/png"] },
      ],
    },
  ],
};

/** A real gzip header, so the content sniffer has something truthful to agree with. */
const GZIP = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);

/** The same, for the slot that takes images. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let migrationPool: Pool;

describe("putting a file on a row", () => {
  let site: PhiTestSite;
  let offeringId: string;
  let actor: number;

  function assets(options?: {
    mayActOnRow?: boolean;
    /** Who is acting, for the cases about a reservation being redeemed by somebody else. */
    actorUserId?: number | null;
    /** Collects what the row authority was asked, so a test can name the intent and not just the answer. */
    intents?: string[];
  }) {
    return buildPhisAddonAssetsCapability({
      addonId: ADDON,
      siteId: site.id,
      siteKey: site.key,
      actorUserId: options && "actorUserId" in options ? (options.actorUserId ?? null) : actor,
      schema: descriptor,
      mayActOnRow: async ({ intent }) => {
        options?.intents?.push(intent);
        return options?.mayActOnRow ?? true;
      },
      proxyUploadUrl: ({ token }) => `/api/site/media/uploads/${token}`,
    });
  }

  /** What the Space holds and what it is holding room for. */
  async function usage() {
    const space = await ensureAddonMediaSpace(site.id, ADDON);
    return { bytes: space.usedBytes, reserved: space.reservedBytes };
  }

  /** Where the store keeps a file, read out of Media because the view deliberately never says. */
  async function storageKeyOf(mediaAssetId: number) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM phis.media_assets WHERE site_id = $1 AND id = $2`,
      [site.id, mediaAssetId],
    );
    return rows[0]?.storage_key ?? null;
  }

  /** Whether the object is still there -- the question the Space's figures cannot answer. */
  async function objectExists(storageKey: string) {
    const space = await ensureAddonMediaSpace(site.id, ADDON);
    const profile = await getMediaStorageProfile(site.id, space.defaultStorageProfileId);
    const service = await createPhisMediaStorageServiceForProfile(profile!, site.key);
    return Boolean(await service.headObject(storageKey));
  }

  /** What the client would do, standing in for the plan the Provider issued. */
  async function deliver(token: string, body: Buffer, contentType = "application/gzip") {
    const session = await getMediaUploadSessionByToken(token);
    const space = await ensureAddonMediaSpace(site.id, ADDON);
    const profile = await getMediaStorageProfile(site.id, space.defaultStorageProfileId);
    const service = await createPhisMediaStorageServiceForProfile(profile!, site.key);
    await service.putObject({
      storageKey: session!.stagingStorageKey,
      body,
      contentType,
    });
  }

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-assetlife");
    actor = await createPhiTestUser(site);

    const config = getPhisConfigSync().database;
    if (!config?.migrationUri || !config.uri) {
      throw new Error("These tests need database.migrationUri and database.uri.");
    }
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

  it("keeps the reservation out of the Add-on's table until the bytes are there", async () => {
    /*
     * The Add-on's table holds facts. While the transfer is in flight the record of it lives in Core's
     * upload session, which is what keeps `status`, an expiry and a token out of a table whose every
     * row is supposed to mean "this file exists".
     */
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: GZIP.byteLength,
    });
    expect(reservation.plan.kind).toBe("proxy-stream");

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query(
      `SELECT id FROM ${SCHEMA}.offering_assets WHERE owner_id = $1`,
      [offeringId],
    );
    expect(rows).toHaveLength(0);
    expect(await assets().list({ table: "offering", ownerId: offeringId })).toEqual([]);

    // And the session does hold it, under the purpose that decides what it becomes.
    const session = await getMediaUploadSessionByToken(reservation.token);
    expect(session).toMatchObject({ purpose: 2, sizeBytes: GZIP.byteLength });
    expect(session!.purposeRef).toMatchObject({ addonId: ADDON, table: "offering", slot: "package" });

    await assets().abandon({ table: "offering", token: reservation.token });
  });

  it("charges the store when the place is made, not when it is used", async () => {
    /*
     * Booking on finalize would let a store be filled by uploads that are merely started: the ceiling
     * would hold on paper while the objects accumulated underneath it.
     */
    const before = await usage();
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: 100,
    });
    // Held, not spent: `reserved_bytes` moves and `used_bytes` does not, which is what lets the
    // reservation be given back without ever having counted as stored.
    const during = await usage();
    expect(during.reserved).toBe(before.reserved + 100);
    expect(during.bytes).toBe(before.bytes);

    await assets().abandon({ table: "offering", token: reservation.token });
    const after = await usage();
    expect(after.reserved).toBe(before.reserved);
  });

  it("makes a file of it once the bytes are there", async () => {
    const pool = await requirePhiTestDatabase();
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: GZIP.byteLength,
    });
    await deliver(reservation.token, GZIP);
    const asset = await assets().finalize({ table: "offering", token: reservation.token });
    expect(asset).toMatchObject({
      slot: "package",
      byteSize: GZIP.byteLength,
      contentType: "application/gzip",
    });
    expect(await assets().list({ table: "offering", ownerId: offeringId }))
      .toHaveLength(1);

    /*
     * No object key comes with it. What an Add-on gets is the Media Asset id, which is what a delivery
     * URL is built from -- a key would be something it could pass to `storage:v1`, and the two spaces
     * are meant to stay apart.
     */
    expect(Object.keys(asset)).not.toContain("storageKey");
    expect(asset.mediaAssetId).toBeGreaterThan(0);

    // And the file sits in the Add-on's own Space, which is the account its quota is kept on.
    const space = await ensureAddonMediaSpace(site.id, ADDON);
    const stored = await pool.query<{ space_id: number }>(
      `SELECT space_id FROM phis.media_assets WHERE id = $1`,
      [asset.mediaAssetId],
    );
    expect(stored.rows[0]!.space_id).toBe(space.id);
  });

  it("spends the reservation when the file is settled, so nothing can release it again", async () => {
    const pool = await requirePhiTestDatabase();
    const before = await usage();
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: GZIP.byteLength,
    });
    await deliver(reservation.token, GZIP);
    const file = await assets().finalize({ table: "offering", token: reservation.token });
    const key = await storageKeyOf(file.mediaAssetId);

    // The row is gone with the commit: a reservation that is spent is not a reservation any more. The
    // bytes are used now and held no longer -- `package` is single-valued, so the file this replaces
    // gives its own bytes back, which is why the figure to hold on to is the one after settling.
    expect(await getMediaUploadSessionByToken(reservation.token)).toBeNull();
    const settled = await usage();
    expect(settled.reserved).toBe(before.reserved);

    /*
     * What the row used to do after its day was over: it stayed behind marked complete, every expiry
     * pass read it as a reservation still held and gave its bytes back a second time, and the sweep
     * took its key for a staged remain. Now there is nothing for a pass to find.
     */
    const space = await ensureAddonMediaSpace(site.id, ADDON);
    await pool.query(
      `UPDATE phis.media_upload_sessions SET expires_at = NOW() - INTERVAL '1 day' WHERE token = $1`,
      [reservation.token],
    );
    expect(await releaseExpiredMediaUploadSessions(space.id)).toHaveLength(0);
    expect(await usage()).toEqual(settled);
    expect(await objectExists(key!)).toBe(true);

    // And asking again is refused, the same answer as for any token that names no reservation.
    await expect(assets().finalize({ table: "offering", token: reservation.token }))
      .rejects.toThrow(/not open/);
  });

  it("refuses to finish an upload that never arrived", async () => {
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "shots",
      contentType: "image/png", sizeBytes: 10,
    });
    await expect(assets().finalize({ table: "offering", token: reservation.token }))
      .rejects.toThrow(/Nothing has been delivered/);
    await assets().abandon({ table: "offering", token: reservation.token });
  });

  it("holds the object to the size that was agreed", async () => {
    // Otherwise the ceiling is advisory: reserve a little, deliver a lot, be charged for the little.
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: 4,
    });
    await deliver(reservation.token, GZIP);
    await expect(assets().finalize({ table: "offering", token: reservation.token }))
      .rejects.toThrow(/was made for 4 bytes and 10 arrived/);
    await assets().abandon({ table: "offering", token: reservation.token });
  });

  it("refuses bytes that are not what the slot was told they would be", async () => {
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "shots",
      contentType: "image/png", sizeBytes: GZIP.byteLength,
    });
    // A header is a claim; the first kilobytes are evidence, and these say gzip.
    await deliver(reservation.token, GZIP);
    await expect(assets().finalize({ table: "offering", token: reservation.token }))
      .rejects.toThrow(/the bytes are a "application\/gzip"/);
    await assets().abandon({ table: "offering", token: reservation.token });
  });

  it("replaces a single-valued slot in one step, and gives the old space back", async () => {
    const before = await usage();
    const [displaced] = await assets().list({ table: "offering", ownerId: offeringId, slot: "package" });
    const displacedKey = await storageKeyOf(displaced!.mediaAssetId);

    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: GZIP.byteLength,
    });
    await deliver(reservation.token, GZIP);
    const replacement = await assets().finalize({ table: "offering", token: reservation.token });

    // Exactly one, and it is the new one: there is no moment at which the row has two packages.
    const held = await assets().list({ table: "offering", ownerId: offeringId, slot: "package" });
    expect(held).toHaveLength(1);
    expect(held[0]!.mediaAssetId).toBe(replacement.mediaAssetId);

    // The replaced file's bytes came back, so replacing does not accumulate.
    const after = await usage();
    expect(after.bytes).toBe(before.bytes);
    // And they came back out of the store as well: the figures alone would say the same either way.
    expect(await objectExists(displacedKey!)).toBe(false);
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
    expect(first.token).not.toBe(second.token);
    await assets().abandon({ table: "offering", token: first.token });
    await assets().abandon({ table: "offering", token: second.token });
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

  it("gives a file's space back exactly once, however often it is asked", async () => {
    /*
     * Double release is worse than none. `GREATEST(0, ...)` keeps a counter off the floor, but a store
     * that has given back more than it holds hands an Add-on room it does not have -- and the ceiling
     * then guards nothing.
     */
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "shots",
      contentType: "image/png", sizeBytes: 6,
    });
    const before = await usage();

    expect(await assets().abandon({ table: "offering", token: reservation.token })).toBe(true);
    // The session is gone, so the second call finds nothing and must not release anything either.
    expect(await assets().abandon({ table: "offering", token: reservation.token })).toBe(false);

    const after = await usage();
    expect(after.reserved).toBe(before.reserved - 6);
  });

  /** What the row itself says about the file, which is what a listing reads instead of asking. */
  async function mirror(id: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ package_path: string | null }>(
      `SELECT package_path FROM ${SCHEMA}.offering WHERE id = $1`,
      [id],
    );
    return rows[0]?.package_path ?? null;
  }

  it("writes the delivery path onto the row, and replaces it when the file does", async () => {
    /*
     * The reason the mirror exists: showing a row's file otherwise means asking for its files, one
     * question per row, so a page of fifty costs fifty. The path travels with the row instead.
     */
    const [held] = await assets().list({ table: "offering", ownerId: offeringId, slot: "package" });
    expect(await mirror(offeringId)).toBe(held!.contentPath);

    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: GZIP.byteLength,
    });
    await deliver(reservation.token, GZIP);
    const replacement = await assets().finalize({ table: "offering", token: reservation.token });
    // The displaced file's path is gone with it: one slot, one path, and never the older of the two.
    expect(await mirror(offeringId)).toBe(replacement.contentPath);
    expect(await mirror(offeringId)).not.toBe(held!.contentPath);

    await assets().remove({ table: "offering", id: replacement.id });
    // Empty rather than stale: a row that kept the path would show a picture that is not there.
    expect(await mirror(offeringId)).toBeNull();

    // Put one back, because the slot is what the tests after this one are about.
    const again = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: GZIP.byteLength,
    });
    await deliver(again.token, GZIP);
    const restored = await assets().finalize({ table: "offering", token: again.token });
    expect(await mirror(offeringId)).toBe(restored.contentPath);
  });

  it("takes a file away with its space, and out of the store", async () => {
    /*
     * The store is asked separately from the figures, because dropping the Asset row alone gives the
     * bytes back to the Space and leaves them in the bucket -- and with the row goes the storage key,
     * so from that moment nothing can find the object again. Every visible sign says the file is gone.
     */
    const before = await usage();
    const held = await assets().list({ table: "offering", ownerId: offeringId, slot: "package" });
    const key = await storageKeyOf(held[0]!.mediaAssetId);
    expect(await objectExists(key!)).toBe(true);

    expect(await assets().remove({ table: "offering", id: held[0]!.id })).toBe(true);
    expect(await assets().list({ table: "offering", ownerId: offeringId, slot: "package" }))
      .toEqual([]);
    const after = await usage();
    expect(after.bytes).toBe(before.bytes - GZIP.byteLength);
    expect(await objectExists(key!)).toBe(false);
  });

  it("addresses a file the way Core addresses its own, cache revision included", async () => {
    /*
     * Without the revision the path still delivers, and delivers with `max-age=0, must-revalidate`
     * forever -- a failure that looks exactly like success. So it is Core that composes it, from the
     * one builder Media itself uses, rather than the Add-on from a route it was never told.
     */
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "package",
      contentType: "application/gzip", sizeBytes: GZIP.byteLength,
    });
    await deliver(reservation.token, GZIP);
    const file = await assets().finalize({ table: "offering", token: reservation.token });

    expect(file.contentPath)
      .toBe(`/api/site/media/${file.mediaAssetId}/content?r=1`);
    // And the same answer when it is read back, not only when it is made.
    const [listed] = await assets().list({ table: "offering", ownerId: offeringId, slot: "package" });
    expect(listed!.contentPath).toBe(file.contentPath);

    await assets().remove({ table: "offering", id: file.id });
  });

  it("reports what it holds against the ceiling that will actually be applied", async () => {
    /*
     * The point of reading this is to explain a refusal before it happens, so the figures have to be
     * the ones `begin` compares: stored bytes and live reservations both count against the same
     * ceiling, and a reservation in flight is as unavailable as a stored byte.
     */
    const before = await assets().usage();
    expect(before).toMatchObject({ bytes: expect.any(Number), reservedBytes: expect.any(Number) });

    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "shots",
      contentType: "image/png", sizeBytes: 40,
    });
    const held = await assets().usage();
    expect(held.reservedBytes).toBe(before.reservedBytes + 40);
    expect(held.bytes).toBe(before.bytes);

    await assets().abandon({ table: "offering", token: reservation.token });
    expect((await assets().usage()).reservedBytes).toBe(before.reservedBytes);
  });

  it("asks the row's authority to read it before saying what it carries", async () => {
    /*
     * Asking what a row carries is reading the row, and the slot's `delivery` cannot stand in for the
     * answer: a file whose id, name and size come back to anybody has already given up most of what
     * `internal` was keeping.
     */
    const intents: string[] = [];
    await assets({ intents }).list({ table: "offering", ownerId: offeringId });
    expect(intents).toEqual(["read"]);

    await expect(assets({ mayActOnRow: false }).list({ table: "offering", ownerId: offeringId }))
      .rejects.toThrow(/is not this caller's to read/);
  });

  it("asks the row's authority to change it before taking a file away", async () => {
    // Taking a file out of a slot changes the row exactly as putting one there does, so it is the same
    // question -- and the file must still be there when the answer was no.
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "shots",
      contentType: "image/png", sizeBytes: PNG.byteLength,
    });
    await deliver(reservation.token, PNG, "image/png");
    const held = await assets().finalize({ table: "offering", token: reservation.token });

    const intents: string[] = [];
    await expect(assets({ mayActOnRow: false, intents }).remove({ table: "offering", id: held.id }))
      .rejects.toThrow(/is not this caller's to change/);
    expect(intents).toEqual(["update"]);
    expect(await assets().list({ table: "offering", ownerId: offeringId, slot: "shots" }))
      .toContainEqual(expect.objectContaining({ id: held.id }));
  });

  it("says nothing about a file that is not there, rather than refusing it", async () => {
    // "May I" about something absent has no honest answer but no, and a refusal would say it exists.
    expect(await assets({ mayActOnRow: false })
      .remove({ table: "offering", id: "999999999" })).toBe(false);
    // And a key that is not one at all names nothing either, rather than raising on its type.
    expect(await assets().remove({ table: "offering", id: "not-a-key" })).toBe(false);
  });

  it("lets only the person a reservation was made for redeem it", async () => {
    /*
     * The row authority `begin` established is spent once, by the actor it was established for.
     * Without this, whoever came to hold the token could spend it -- and the check at the start would
     * have decided nothing about who finishes.
     */
    const stranger = await createPhiTestUser(site);
    const reservation = await assets().begin({
      table: "offering", ownerId: offeringId, slot: "shots",
      contentType: "image/png", sizeBytes: PNG.byteLength,
    });
    await deliver(reservation.token, PNG, "image/png");

    const theirs = assets({ actorUserId: stranger });
    await expect(theirs.finalize({ table: "offering", token: reservation.token }))
      .rejects.toThrow(/is not open/);
    expect(await theirs.abandon({ table: "offering", token: reservation.token })).toBe(false);
    // Still the reservation it was, and still redeemable by the one who made it.
    expect(await assets().abandon({ table: "offering", token: reservation.token })).toBe(true);
  });

});
