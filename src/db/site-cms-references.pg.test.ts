import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestAsset,
  createPhiTestAssetReference,
  createPhiTestPageReference,
  createPhiTestPageScope,
  createPhiTestSite,
  createPhiTestThemeScope,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * `ON DELETE RESTRICT` on the two target columns is what keeps a referenced Page or Asset from
 * vanishing under a Page that points at it. The unit suite pins that the guards issue the right
 * statements; only the database can say whether the constraint actually holds.
 */
describe("site_cms_references referential actions", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("references");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("refuses to delete a Page Scope a reference points at", async () => {
    const pool = await requirePhiTestDatabase();
    const source = await createPhiTestPageScope(site, "/pgtest-source-a");
    const target = await createPhiTestPageScope(site, "/pgtest-target-a");
    await createPhiTestPageReference(site, source, target);

    await expect(
      pool.query(`DELETE FROM phis.site_page_scopes WHERE id = $1`, [target]),
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await pool.query(`SELECT id FROM phis.site_page_scopes WHERE id = $1`, [target]);
    expect(rows).toHaveLength(1);
  });

  it("refuses to delete an Asset a reference points at", async () => {
    const pool = await requirePhiTestDatabase();
    const source = await createPhiTestPageScope(site, "/pgtest-source-b");
    const asset = await createPhiTestAsset(site, "pgtest/asset-b");
    await createPhiTestAssetReference(site, source, asset);

    await expect(
      pool.query(`DELETE FROM phis.media_assets WHERE id = $1`, [asset]),
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await pool.query(`SELECT id FROM phis.media_assets WHERE id = $1`, [asset]);
    expect(rows).toHaveLength(1);
  });

  it("refuses to delete an Asset the Site Theme points at", async () => {
    // The Theme is the Site-wide source, and the picture it holds is the one a Module's ground was
    // taken over into. Its rows have to hold the Asset down like any other source's do.
    const pool = await requirePhiTestDatabase();
    const themeScope = await createPhiTestThemeScope(site);
    const asset = await createPhiTestAsset(site, "pgtest/asset-theme");
    await createPhiTestAssetReference(site, themeScope, asset, 5);

    await expect(
      pool.query(`DELETE FROM phis.media_assets WHERE id = $1`, [asset]),
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await pool.query(`SELECT id FROM phis.media_assets WHERE id = $1`, [asset]);
    expect(rows).toHaveLength(1);
  });

  it("rejects a source kind the contract does not name", async () => {
    const pool = await requirePhiTestDatabase();
    const asset = await createPhiTestAsset(site, "pgtest/asset-kind");

    await expect(
      pool.query(
        `INSERT INTO phis.site_cms_references (
           site_id, source_kind, source_scope_id, source_location, target_kind, target_asset_id
         ) VALUES ($1, 6, 1, 'pgtest', 3, $2)`,
        [site.id, asset],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("releases the target once the reference is gone", async () => {
    const pool = await requirePhiTestDatabase();
    const source = await createPhiTestPageScope(site, "/pgtest-source-c");
    const target = await createPhiTestPageScope(site, "/pgtest-target-c");
    await createPhiTestPageReference(site, source, target);

    await pool.query(
      `DELETE FROM phis.site_cms_references WHERE site_id = $1 AND target_page_scope_id = $2`,
      [site.id, target],
    );
    await pool.query(`DELETE FROM phis.site_page_scopes WHERE id = $1`, [target]);

    const { rows } = await pool.query(`SELECT id FROM phis.site_page_scopes WHERE id = $1`, [target]);
    expect(rows).toHaveLength(0);
  });

  it("rejects a reference whose target identity does not match its target kind", async () => {
    const pool = await requirePhiTestDatabase();
    const source = await createPhiTestPageScope(site, "/pgtest-source-d");
    const target = await createPhiTestPageScope(site, "/pgtest-target-d");

    // target_kind 1 is a Page, which the check constraint requires to carry an Area.
    await expect(
      pool.query(
        `INSERT INTO phis.site_cms_references (
           site_id, source_kind, source_scope_id, source_location,
           target_kind, target_area_id, target_page_scope_id
         ) VALUES ($1, 1, $2, 'pgtest', 1, NULL, $3)`,
        [site.id, source, target],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
