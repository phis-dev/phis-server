import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  phisAddonStoragePrefix,
  readPhisAddonStorageSites,
  recountPhisAddonStorage,
  removePhisAddonStorage,
  type PhisAddonStorageSite,
} from "../cli/storage-purge.mts";
import { sweepPhisAddonAssets } from "../cli/storage-sweep.mts";
import { ensureAddonMediaSpace } from "./media-spaces";
import { readPhisAddonStorageUsage } from "./server-addon-storage-usage.mts";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * Clearing up after an Add-on, and correcting the figure that says how much there is.
 *
 * Both exist because object storage is not in the transaction. A purge empties Core's tables atomically
 * and the bytes are somewhere else entirely, so removing them is a second act that can fail on its own
 * -- and the counters, which Core keeps as a running total, can describe a store that no longer matches.
 *
 * The interesting case for the recount is drift downward: a store whose figure says it is full while
 * the objects are gone refuses writes against space that is free, and the error mentions a ceiling
 * rather than the reason.
 */

const ADDON = "@pgtest/storage-cleanup";

describe("clearing an Add-on's store", () => {
  let site: PhiTestSite;
  let root: string;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-storage-cleanup");
    root = await mkdtemp(path.join(tmpdir(), "phis-cleanup-"));
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
       VALUES ($1, $2, 999999, 42)
       ON CONFLICT (site_id, addon_id) DO NOTHING`,
      [site.id, ADDON],
    );
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await rm(root, { recursive: true, force: true });
    await pool.query(`DELETE FROM phis.site_server_addons WHERE addon_id = $1`, [ADDON]);
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await closePhiTestPool();
  });

  function localSite(): PhisAddonStorageSite {
    return {
      siteId: site.id,
      siteKey: site.key,
      providerId: "@phis/server/storage-local",
      config: { rootDir: root },
      secretReference: null,
    };
  }

  it("finds the Sites a store has to be cleared on, while the rows still say so", async () => {
    // Read before the purge, because `site_server_addons` is one of the tables it empties.
    const stores = await readPhisAddonStorageSites(await requirePhiTestDatabase(), ADDON);
    expect(stores.map((store) => store.siteKey)).toContain(site.key);
  });

  it("writes under the prefix the capability writes under, and nowhere else", () => {
    const prefix = phisAddonStoragePrefix(ADDON, site.key);
    expect(prefix).toBe(`addons/phis_addon_pgtest_storage_cleanup/${site.key}`);
  });

  it("removes the whole store of a Site from the built-in storage", async () => {
    const directory = path.join(root, phisAddonStoragePrefix(ADDON, site.key));
    await mkdir(path.join(directory, "artifacts"), { recursive: true });
    await writeFile(path.join(directory, "artifacts", "one.bin"), "x");
    await writeFile(path.join(directory, "artifacts", "two.bin"), "yy");

    const removal = await removePhisAddonStorage(localSite(), ADDON, async () => null);
    expect(removal.error).toBeNull();
    // The Site's own directory goes; the empty parent above it may stay, and holds nothing either way.
    expect(await readdir(directory).catch(() => null)).toBeNull();
  });

  it("is not an error to clear a store that was never written to", async () => {
    const removal = await removePhisAddonStorage(localSite(), ADDON, async () => null);
    expect(removal).toMatchObject({ error: null, removed: 0 });
  });

  it("reports an unreachable Provider rather than ending the run", async () => {
    /*
     * By this point the rows are already gone, so throwing would help nobody: what an operator needs is
     * the list of Sites whose objects are still there.
     */
    const removal = await removePhisAddonStorage(
      { ...localSite(), providerId: "@acme/storage/elsewhere" },
      ADDON,
      async () => { throw new Error("the endpoint refused the credential"); },
    );
    expect(removal.error).toMatch(/refused the credential/);
    expect(removal.removed).toBe(0);
  });

  it("brings a drifted figure back to what the store actually holds", async () => {
    const pool = await requirePhiTestDatabase();
    // The row was seeded claiming a megabyte across 42 objects; the store holds two small ones.
    const before = await readPhisAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    expect(before.bytes).toBe(999999);

    // What a Provider answers to a string-prefix listing: this Site's two objects, and one of a Site
    // whose key merely begins the same way. The recount may count only the first two.
    const own = phisAddonStoragePrefix(ADDON, site.key);
    const neighbour = phisAddonStoragePrefix(ADDON, `${site.key}-eu`);
    const result = await recountPhisAddonStorage(pool, {
      addonId: ADDON,
      site: localSite(),
      listPrefix: async () => [
        { storageKey: `${own}/a`, byteSize: 10 },
        { storageKey: `${own}/b`, byteSize: 15 },
        { storageKey: `${neighbour}/c`, byteSize: 1000 },
      ],
    });
    expect(result).toMatchObject({ bytes: 25, objects: 2, applied: true });

    const after = await readPhisAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    expect(after).toMatchObject({ bytes: 25, objects: 2 });
  });

  it("sweeps nothing where the Add-on has no link tables to judge orphans by", async () => {
    const pool = await requirePhiTestDatabase();
    const space = await ensureAddonMediaSpace(site.id, ADDON);
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_assets
         (site_id, space_id, storage_profile_id, storage_key, original_name, content_type,
          bytes, lifecycle_status, delivery_policy)
       VALUES ($1, $2, $3, 'addons/pgtest/keep.bin', 'keep.bin', 'application/octet-stream', 12, 2, 1)
       RETURNING id`,
      [site.id, space.id, site.storageProfileId],
    );

    // No schema is applied for this Add-on, so there is no link table. The pass used to read that as
    // "nothing links anything" and delete every Asset in the Space; it declines to judge instead.
    const swept = await sweepPhisAddonAssets(pool, { addonId: ADDON, siteId: site.id, siteKey: site.key });
    expect(swept.orphaned).toBe(0);
    expect(swept.storageKeys).toEqual([]);
    const kept = await pool.query(`SELECT id FROM phis.media_assets WHERE id = $1`, [rows[0]!.id]);
    expect(kept.rows).toHaveLength(1);
  });

  it("says so when there is no row to correct", async () => {
    const result = await recountPhisAddonStorage(await requirePhiTestDatabase(), {
      addonId: ADDON,
      site: { ...localSite(), siteId: 32000 },
      listPrefix: async () => [],
    });
    expect(result.applied).toBe(false);
  });
});
