import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ensureAddonMediaSpace,
  getMediaSpaceById,
  listAddonMediaSpaces,
  reserveMediaSpaceQuota,
  setMediaSpaceQuotaBytes,
  updateSiteMediaConfig,
} from "@/db/media-spaces";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * An Add-on Space is delegated capacity, and is bounded like the other two kinds.
 *
 * The Space's quota IS the Add-on's quota -- that is why the fourth kind exists rather than a second
 * counter beside the Add-on's rows. What makes that true is inheritance: a Space nobody sized reads the
 * Site's default for its kind, exactly as a User and a Group Space do. Without that rail an Add-on Space
 * is the one delegated Space born unlimited, and it has no owner who would notice.
 */

describe("an Add-on Space's quota", () => {
  let site: PhiTestSite;
  const ADDON_ID = "@pgtest/quota-addon";

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-quota");
    // The Space's foreign key requires the Add-on to exist: a Space for an Add-on nobody installed is
    // capacity assigned to nothing.
    await pool.query(
      `INSERT INTO phis.server_addons (addon_id, package_name, package_version, server_abi,
         manifest_digest, release_build_id, schema_name)
       VALUES ($1, $1, '0.0.0', 'v1', repeat('a', 64), 'pgtest', 'phis_addon_pgtest_quota')
       ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON_ID],
    );
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON_ID]);
    await closePhiTestPool();
  });

  it("inherits the Site default for its kind, like every other delegated Space", async () => {
    const space = await ensureAddonMediaSpace(site.id, ADDON_ID);
    await updateSiteMediaConfig(site.id, { defaultAddonQuotaBytes: 1_000 });

    // The Space itself carries no override; the figure that binds comes from the Site.
    expect((await getMediaSpaceById(site.id, space.id))?.quotaBytes).toBeNull();
    expect(await reserveMediaSpaceQuota({ spaceId: space.id, bytes: 900 })).toBe(true);
    // 900 already reserved, so 200 more does not fit under a default of 1000.
    expect(await reserveMediaSpaceQuota({ spaceId: space.id, bytes: 200 })).toBe(false);
  });

  it("lets one Add-on depart from the Site default", async () => {
    const space = await ensureAddonMediaSpace(site.id, ADDON_ID);
    await updateSiteMediaConfig(site.id, { defaultAddonQuotaBytes: 10 });
    await setMediaSpaceQuotaBytes(site.id, space.id, 5_000);

    // The override wins over the default, in the direction that matters: the Add-on that needs room.
    expect(await reserveMediaSpaceQuota({ spaceId: space.id, bytes: 4_000 })).toBe(true);
  });

  it("is unlimited only while the Site says nothing", async () => {
    const space = await ensureAddonMediaSpace(site.id, ADDON_ID);
    await setMediaSpaceQuotaBytes(site.id, space.id, null);
    await updateSiteMediaConfig(site.id, { defaultAddonQuotaBytes: null });

    expect(await reserveMediaSpaceQuota({ spaceId: space.id, bytes: 10_000_000 })).toBe(true);
  });

  it("takes an explicit zero as a revocation and not as absence", async () => {
    const space = await ensureAddonMediaSpace(site.id, ADDON_ID);
    await setMediaSpaceQuotaBytes(site.id, space.id, 0);

    // COALESCE would read a NULL override as "ask the Site"; a zero has to mean zero.
    expect(await reserveMediaSpaceQuota({ spaceId: space.id, bytes: 1 })).toBe(false);
  });

  it("is reported to administration, which nothing else does", async () => {
    await ensureAddonMediaSpace(site.id, ADDON_ID);

    const spaces = await listAddonMediaSpaces(site.id);
    const listed = spaces.find((entry) => entry.addonId === ADDON_ID);
    // Not browsable and owned by nobody: without this listing an administrator could not learn the
    // address of the Space they are being asked to size.
    expect(listed).toBeDefined();
    expect(listed!.space.kind).toBe(4);
  });
});
