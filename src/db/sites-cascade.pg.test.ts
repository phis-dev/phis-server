import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestAsset,
  createPhiTestAssetReference,
  createPhiTestPageScope,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
} from "../../test/pg/harness";

/**
 * Deleting a Site has to cascade through everything that hangs off it, including the branches that
 * reach a Storage Profile from two directions at once. Five of those foreign keys are deferred rather
 * than immediate so the whole-aggregate delete succeeds while a targeted delete still fails; both
 * halves are pinned here, because losing either one is silent until someone deletes a Site.
 */
describe("Site cascade graph", () => {
  beforeAll(async () => {
    await dropPhiTestSites();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("deletes a Site that carries Assets, variants, references and a Space", async () => {
    const pool = await requirePhiTestDatabase();
    const site = await createPhiTestSite("cascade");
    const source = await createPhiTestPageScope(site, "/pgtest-cascade-source");
    const asset = await createPhiTestAsset(site, "pgtest/cascade");
    await createPhiTestAssetReference(site, source, asset);
    await pool.query(
      `INSERT INTO phis.image_asset_variants (
         asset_id, variant_key, storage_profile_id, storage_key, content_type, width, height
       ) VALUES ($1, 1, $2, $3, 'image/webp', 64, 64)`,
      [asset, site.storageProfileId, "pgtest/cascade@1"],
    );

    await pool.query(`DELETE FROM phis.sites WHERE id = $1`, [site.id]);

    const { rows } = await pool.query<{ remaining: string }>(
      `SELECT
         (SELECT count(*) FROM phis.media_assets WHERE site_id = $1)
       + (SELECT count(*) FROM phis.media_spaces WHERE site_id = $1)
       + (SELECT count(*) FROM phis.media_storage_profiles WHERE site_id = $1)
       + (SELECT count(*) FROM phis.site_page_scopes WHERE site_id = $1)
       + (SELECT count(*) FROM phis.site_cms_references WHERE site_id = $1) AS remaining`,
      [site.id],
    );
    expect(rows[0]?.remaining).toBe("0");
  });

  it("still refuses to delete a Storage Profile that holds content", async () => {
    const pool = await requirePhiTestDatabase();
    const site = await createPhiTestSite("profile-guard");
    await createPhiTestAsset(site, "pgtest/profile-guard");

    // Deferred: the statement passes and COMMIT is what raises, so the guard needs its own transaction.
    const client = await (await requirePhiTestDatabase()).connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM phis.media_storage_profiles WHERE id = $1`, [site.storageProfileId]);
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23503" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const { rows } = await pool.query(
      `SELECT id FROM phis.media_storage_profiles WHERE id = $1`,
      [site.storageProfileId],
    );
    expect(rows).toHaveLength(1);
  });
});
