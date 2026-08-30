import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestAsset,
  createPhiTestGroupSpace,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { getMediaAssetBySiteAndId, updateMediaAsset } from "./media";

/**
 * `delivery_revision` is the cache key every Media URL carries, and a Public Asset is served with a
 * year of immutable caching when the request matches it. Rotation is therefore not an optimization:
 * it is the only thing that ends the life of an already-delivered copy.
 */
describe("delivery revision rotation against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("delivery-revision");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function readRevision(assetId: number) {
    return (await getMediaAssetBySiteAndId(site.id, assetId))?.deliveryRevision ?? null;
  }

  it("starts every Asset at revision one", async () => {
    const assetId = await createPhiTestAsset(site, "pgtest/rev-initial");

    expect(await readRevision(assetId)).toBe(1);
  });

  // The case that made this a correctness problem rather than a cache nicety: narrowing an Asset from
  // Public to Group has to end the immutable copies, or the content stays readable to a public that
  // may no longer see it.
  it("rotates when the delivery policy is narrowed", async () => {
    const assetId = await createPhiTestAsset(site, "pgtest/rev-policy");

    const updated = await updateMediaAsset({
      siteId: site.id, spaceId: site.siteSpaceId, assetId, deliveryPolicy: 4,
    });

    expect(updated?.deliveryPolicy).toBe(4);
    expect(updated?.deliveryRevision).toBe(2);
  });

  it("rotates on a metadata change too", async () => {
    const assetId = await createPhiTestAsset(site, "pgtest/rev-title");

    await updateMediaAsset({ siteId: site.id, spaceId: site.siteSpaceId, assetId, title: "pgtest" });

    expect(await readRevision(assetId)).toBe(2);
  });

  it("rotates once per change and keeps counting", async () => {
    const assetId = await createPhiTestAsset(site, "pgtest/rev-repeat");

    await updateMediaAsset({ siteId: site.id, spaceId: site.siteSpaceId, assetId, title: "one" });
    await updateMediaAsset({ siteId: site.id, spaceId: site.siteSpaceId, assetId, altText: "two" });
    await updateMediaAsset({ siteId: site.id, spaceId: site.siteSpaceId, assetId, lifecycleStatus: 2 });

    expect(await readRevision(assetId)).toBe(4);
  });

  it("does not rotate when the caller names no field", async () => {
    const assetId = await createPhiTestAsset(site, "pgtest/rev-noop");

    await updateMediaAsset({ siteId: site.id, spaceId: site.siteSpaceId, assetId });

    expect(await readRevision(assetId)).toBe(1);
  });

  it("does not rotate an Asset addressed through the wrong Space", async () => {
    const assetId = await createPhiTestAsset(site, "pgtest/rev-scope");
    const otherSpaceId = await createPhiTestGroupSpace(site, 1_000);

    const updated = await updateMediaAsset({
      siteId: site.id, spaceId: otherSpaceId, assetId, title: "pgtest",
    });

    expect(updated).toBeNull();
    expect(await readRevision(assetId)).toBe(1);
  });

  it("never leaves the revision at or below zero", async () => {
    const pool = await requirePhiTestDatabase();
    const assetId = await createPhiTestAsset(site, "pgtest/rev-check");

    await expect(
      pool.query(`UPDATE phis.media_assets SET delivery_revision = 0 WHERE id = $1`, [assetId]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
