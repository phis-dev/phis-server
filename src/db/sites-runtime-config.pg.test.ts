import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestAsset,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { getSiteRuntimeConfig } from "./sites";

/**
 * The Site's runtime configuration resolves the pictures its Theme names: the Logo per mode and the
 * Signet, each to Core's delivery address with the cache revision.
 */
describe("the runtime configuration's brand", () => {
  let site: PhiTestSite;

  async function setBrand(brand: Record<string, unknown>) {
    const pool = await requirePhiTestDatabase();
    await pool.query(`UPDATE phis.sites SET theme = $2::jsonb WHERE id = $1`, [site.id, JSON.stringify({ brand })]);
  }
  const brandOf = async () => ((await getSiteRuntimeConfig(site.id))!.theme as { brand: Record<string, unknown> }).brand;

  beforeAll(async () => {
    site = await createPhiTestSite("runtime-brand");
    // The runtime configuration is the Site's once it is active (flag 1).
    await (await requirePhiTestDatabase()).query(`UPDATE phis.sites SET flags = flags | 1 WHERE id = $1`, [site.id]);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("resolves the Signet as it resolves the Logo, and adds the type and size the Asset records", async () => {
    const pool = await requirePhiTestDatabase();
    const signet = await createPhiTestAsset(site, "brand-signet", { lifecycleStatus: 2 });
    const logo = await createPhiTestAsset(site, "brand-logo", { lifecycleStatus: 2 });
    await pool.query(`UPDATE phis.media_assets SET width = 180, height = 180, delivery_revision = 4 WHERE id = $1`, [signet]);
    await pool.query(`UPDATE phis.media_assets SET delivery_revision = 2, alt_text = 'The logo' WHERE id = $1`, [logo]);
    await setBrand({
      logo: { light: { sourceKind: "asset", assetId: logo } },
      signet: { sourceKind: "asset", assetId: signet },
    });
    const brand = await brandOf();
    expect(brand.logo).toEqual({ light: { sourceKind: "asset", assetId: logo, url: `/api/site/media/${logo}/content?r=2` } });
    expect(brand.logoAlt).toBe("The logo");
    expect(brand.signet).toEqual({
      sourceKind: "asset", assetId: signet, url: `/api/site/media/${signet}/content?r=4`,
      contentType: "image/png", width: 180, height: 180,
    });
  });

  it("leaves out a size the Asset does not hold, and passes a Signet by address or without an Asset through", async () => {
    const signet = await createPhiTestAsset(site, "brand-signet-unmeasured", { lifecycleStatus: 2 });
    await setBrand({ signet: { sourceKind: "asset", assetId: signet } });
    const measured = (await brandOf()).signet as Record<string, unknown>;
    expect(measured).toEqual({ sourceKind: "asset", assetId: signet, url: `/api/site/media/${signet}/content?r=1`, contentType: "image/png" });

    await setBrand({ signet: { sourceKind: "url", sourceUrl: "data:image/png;base64,AAAA" } });
    expect((await brandOf()).signet).toEqual({ sourceKind: "url", sourceUrl: "data:image/png;base64,AAAA" });
    // An Asset that is not the Site's, or is gone, is not resolved and not invented.
    await setBrand({ signet: { sourceKind: "asset", assetId: 2_000_000_000 } });
    expect((await brandOf()).signet).toEqual({ sourceKind: "asset", assetId: 2_000_000_000 });
    await setBrand({ logoAlt: "x" });
    expect((await brandOf()).signet).toBeUndefined();
  });
});
