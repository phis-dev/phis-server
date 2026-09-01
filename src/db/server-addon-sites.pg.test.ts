import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPhiServerConfigSync } from "@/lib/config";
import {
  ensurePhiServerAddonSiteGroups,
  readPhiServerAddonSiteGroups,
  retirePhiServerAddonSiteGroups,
} from "./server-addon-groups.mts";
import {
  readPhiServerAddonEnabledSiteIds,
  readPhiServerAddonSiteStates,
  setPhiServerAddonSiteEnabled,
} from "./server-addon-sites.mts";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * Asking for an Add-on on a Site, and the groups that come with it.
 *
 * The row this writes was declared in the first migration and written by nothing until now, which is
 * why it needs a test at all: every installation so far reached this state by hand.
 *
 * The group half is here rather than in a unit test because retirement is the interesting part and it
 * is a database fact. A removed Add-on must not take memberships with it, and a re-enabled one must
 * find them again -- neither is visible in a descriptor.
 */

const ADDON = "@pgtest/sites";
const DECLARED = [{ key: "market", name: "Marketplace" }];

let pool: Pool;

describe("activating an Add-on for a Site", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-sites");
    other = await createPhiTestSite("addon-sites-other");
    const config = getPhiServerConfigSync().database;
    if (!config?.uri) {
      throw new Error("These tests need database.uri.");
    }
    // The catalog row the Site row points at. The harness creates one per Add-on id it is asked about.
    await pool.query(
      `INSERT INTO phis.server_addons
         (addon_id, package_name, package_version, server_abi, manifest_digest,
          migration_version, release_build_id, flags)
       VALUES ($1, $1, '0.0.0', '^1', 'pgtest', 0, 'pgtest', 0)
       ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM phis.site_server_addons WHERE addon_id = $1`, [ADDON]);
    await pool.query(`DELETE FROM phis.site_groups WHERE provider_id = $1`, [ADDON]);
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("creates the row a Site's request lives in, which nothing used to do", async () => {
    const state = await setPhiServerAddonSiteEnabled(pool, {
      addonId: ADDON,
      siteId: site.id,
      enabled: true,
    });
    expect(state).toMatchObject({ requestedEnabled: true, configurationStatus: "missing" });
    expect(await readPhiServerAddonEnabledSiteIds(pool, ADDON)).toEqual([site.id]);
  });

  it("says nothing about what the Site actually gets, only what it asked for", async () => {
    const [state] = await readPhiServerAddonSiteStates(pool, ADDON);
    // Requested and effective are different questions; the second one depends on the artifact loading
    // and the configuration being complete, neither of which this row can know.
    expect(state!.requestedEnabled).toBe(true);
    expect(state!.effectiveStatus).toBe("disabled");
  });

  it("creates the declared groups, and says which were new", async () => {
    const first = await ensurePhiServerAddonSiteGroups(pool, {
      addonId: ADDON,
      siteId: site.id,
      declared: DECLARED,
    });
    expect(first).toEqual([{ key: "market", groupId: expect.any(Number), action: "created" }]);

    const again = await ensurePhiServerAddonSiteGroups(pool, {
      addonId: ADDON,
      siteId: site.id,
      declared: DECLARED,
    });
    expect(again[0]!.action).toBe("present");
    expect(again[0]!.groupId).toBe(first[0]!.groupId);
  });

  it("keeps one Site's group apart from another's", async () => {
    await ensurePhiServerAddonSiteGroups(pool, {
      addonId: ADDON,
      siteId: other.id,
      declared: DECLARED,
    });
    const here = await readPhiServerAddonSiteGroups(pool, { addonId: ADDON, siteId: site.id });
    const there = await readPhiServerAddonSiteGroups(pool, { addonId: ADDON, siteId: other.id });
    expect(here).toHaveLength(1);
    expect(there).toHaveLength(1);
    expect(here[0]!.id).not.toBe(there[0]!.id);
  });

  it("retires a group rather than deleting it, and finds it again on the way back", async () => {
    const before = await readPhiServerAddonSiteGroups(pool, { addonId: ADDON, siteId: site.id });
    const retired = await retirePhiServerAddonSiteGroups(pool, {
      addonId: ADDON,
      siteId: site.id,
    });
    expect(retired).toHaveLength(1);
    expect(await readPhiServerAddonSiteGroups(pool, { addonId: ADDON, siteId: site.id })).toEqual([]);

    // The row is still there -- which is the whole point, because the memberships hang off it.
    const { rows } = await pool.query(
      `SELECT id FROM phis.site_groups WHERE provider_id = $1 AND site_id = $2`,
      [ADDON, site.id],
    );
    expect(rows).toHaveLength(1);

    const restored = await ensurePhiServerAddonSiteGroups(pool, {
      addonId: ADDON,
      siteId: site.id,
      declared: DECLARED,
    });
    expect(restored[0]).toMatchObject({ action: "restored", groupId: before[0]!.id });
  });

  it("withdraws the request without touching the row's history", async () => {
    const state = await setPhiServerAddonSiteEnabled(pool, {
      addonId: ADDON,
      siteId: site.id,
      enabled: false,
    });
    expect(state).toMatchObject({ requestedEnabled: false, effectiveStatus: "disabled" });
    // The other Site was given groups but never asked for the Add-on, so nothing is left asking.
    expect(await readPhiServerAddonEnabledSiteIds(pool, ADDON)).toEqual([]);
  });

  it("refuses to withdraw what was never asked for, instead of pretending it worked", async () => {
    const missing = await setPhiServerAddonSiteEnabled(pool, {
      addonId: ADDON,
      siteId: 32_000,
      enabled: false,
    });
    expect(missing).toBeNull();
  });
});
