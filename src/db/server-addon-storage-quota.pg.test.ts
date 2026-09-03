import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bookPhisAddonStorage,
  readPhisAddonStorageUsage,
  setPhisAddonStorageQuota,
} from "./server-addon-storage-usage.mts";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * The ceiling on an Add-on's object store, against a real database.
 *
 * The case worth the database is the concurrent one. Read the total, find room, then write: two uploads
 * arriving together both read the same figure, both find room, and both proceed -- and the store ends up
 * past its ceiling with nothing in the log to say when. One conditional `UPDATE` removes that, because
 * the database decides it once per attempt, and an update that matches no row *is* the refusal.
 *
 * The rest is arithmetic that has to be right for the ceiling to mean anything over time: an overwrite
 * costs the difference and no object, a removal gives back what it held, and a release is never refused.
 */

const ADDON = "@pgtest/storage-quota";

describe("an Add-on's storage ceiling", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-storage-quota");
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
    await pool.query(`DELETE FROM phis.site_server_addons WHERE addon_id = $1`, [ADDON]);
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await closePhiTestPool();
  });

  async function reset(quotaBytes: number | null, quotaObjects: number | null) {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `UPDATE phis.site_server_addons
          SET storage_used_bytes = 0, storage_used_objects = 0
        WHERE addon_id = $1 AND site_id = $2`,
      [ADDON, site.id],
    );
    await setPhisAddonStorageQuota(pool, {
      addonId: ADDON, siteId: site.id, quotaBytes, quotaObjects,
    });
  }

  it("lets a write through while there is room, and refuses the one that would not fit", async () => {
    const pool = await requirePhiTestDatabase();
    await reset(1000, null);

    expect(await bookPhisAddonStorage(pool, {
      addonId: ADDON, siteId: site.id, bytes: 900, objects: 1,
    })).toBe("booked");
    expect(await bookPhisAddonStorage(pool, {
      addonId: ADDON, siteId: site.id, bytes: 200, objects: 1,
    })).toBe("over-quota");

    // The refusal changed nothing: a rejected booking must not have happened.
    const usage = await readPhisAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    expect(usage.bytes).toBe(900);
    expect(usage.objects).toBe(1);
  });

  it("holds when writes arrive together, which is the whole reason it is one statement", async () => {
    const pool = await requirePhiTestDatabase();
    await reset(1000, null);

    // Ten at once, each of which fits on its own and only four of which fit together.
    const booked = await Promise.all(
      Array.from({ length: 10 }, () => bookPhisAddonStorage(pool, {
        addonId: ADDON, siteId: site.id, bytes: 250, objects: 1,
      })),
    );
    expect(booked.filter((outcome) => outcome === "booked")).toHaveLength(4);

    const usage = await readPhisAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    expect(usage.bytes).toBe(1000);
  });

  it("counts objects as its own ceiling, because bytes do not express a crowded store", async () => {
    const pool = await requirePhiTestDatabase();
    await reset(null, 2);

    expect(await bookPhisAddonStorage(pool, { addonId: ADDON, siteId: site.id, bytes: 1, objects: 1 })).toBe("booked");
    expect(await bookPhisAddonStorage(pool, { addonId: ADDON, siteId: site.id, bytes: 1, objects: 1 })).toBe("booked");
    expect(await bookPhisAddonStorage(pool, { addonId: ADDON, siteId: site.id, bytes: 1, objects: 1 })).toBe("over-quota");
  });

  it("charges an overwrite the difference and no object", async () => {
    const pool = await requirePhiTestDatabase();
    await reset(1000, 1);

    await bookPhisAddonStorage(pool, { addonId: ADDON, siteId: site.id, bytes: 400, objects: 1 });
    // The same key written again at 600: 200 more bytes, still one object -- which the object ceiling
    // of 1 would otherwise refuse.
    expect(await bookPhisAddonStorage(pool, {
      addonId: ADDON, siteId: site.id, bytes: 200, objects: 0,
    })).toBe("booked");

    const usage = await readPhisAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    expect(usage).toMatchObject({ bytes: 600, objects: 1 });
  });

  it("gives capacity back, and never refuses a release", async () => {
    const pool = await requirePhiTestDatabase();
    await reset(1000, 5);

    await bookPhisAddonStorage(pool, { addonId: ADDON, siteId: site.id, bytes: 1000, objects: 5 });
    expect(await bookPhisAddonStorage(pool, { addonId: ADDON, siteId: site.id, bytes: 1, objects: 1 })).toBe("over-quota");

    // A release is a booking with negative numbers, and the ceiling has no say over giving back.
    expect(await bookPhisAddonStorage(pool, {
      addonId: ADDON, siteId: site.id, bytes: -400, objects: -2,
    })).toBe("booked");
    expect(await bookPhisAddonStorage(pool, { addonId: ADDON, siteId: site.id, bytes: 1, objects: 1 })).toBe("booked");
  });

  it("does not let a count drift below zero and hand out free space", async () => {
    const pool = await requirePhiTestDatabase();
    await reset(1000, 5);

    await bookPhisAddonStorage(pool, { addonId: ADDON, siteId: site.id, bytes: -5000, objects: -50 });
    const usage = await readPhisAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    expect(usage).toMatchObject({ bytes: 0, objects: 0 });
  });

  it("treats no ceiling and a ceiling of zero as different answers", async () => {
    const pool = await requirePhiTestDatabase();
    await reset(0, null);
    expect(await bookPhisAddonStorage(pool, { addonId: ADDON, siteId: site.id, bytes: 1, objects: 1 })).toBe("over-quota");

    await setPhisAddonStorageQuota(pool, { addonId: ADDON, siteId: site.id, quotaBytes: null });
    expect(await bookPhisAddonStorage(pool, { addonId: ADDON, siteId: site.id, bytes: 1, objects: 1 })).toBe("booked");
  });

  it("leaves the other ceiling alone when only one is being set", async () => {
    const pool = await requirePhiTestDatabase();
    await reset(1000, 7);

    await setPhisAddonStorageQuota(pool, { addonId: ADDON, siteId: site.id, quotaBytes: 2000 });
    const usage = await readPhisAddonStorageUsage(pool, { addonId: ADDON, siteId: site.id });
    expect(usage.quotaBytes).toBe(2000);
    expect(usage.quotaObjects).toBe(7);
  });

  it("says a store that does not exist is not a store that is full", async () => {
    /*
     * The two need different words. "Full" on an Add-on that was never activated reads "0 of unlimited
     * bytes", which sends an operator to raise a ceiling that was never the problem and an author
     * looking for bytes nobody wrote.
     */
    const pool = await requirePhiTestDatabase();
    expect(await bookPhisAddonStorage(pool, {
      addonId: ADDON, siteId: 32000, bytes: 1, objects: 1,
    })).toBe("not-activated");
  });

  it("refuses to bound an Add-on that is not activated for the Site", async () => {
    const pool = await requirePhiTestDatabase();
    expect(await setPhisAddonStorageQuota(pool, {
      addonId: ADDON, siteId: 32000, quotaBytes: 10,
    })).toBe(false);
  });
});
