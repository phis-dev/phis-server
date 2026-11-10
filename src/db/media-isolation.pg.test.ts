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
import {
  getMediaAssetBySiteAndChecksum,
  getMediaAssetBySiteAndId,
  getMediaAssetsByIds,
  listPublicSiteSpaceMediaAssetsByIds,
} from "./media";
import { getMediaSpaceById } from "./media-spaces";

/**
 * Every Media read is scoped twice, by Site and by Space, and the composite foreign keys are what make
 * the second scope structural rather than a convention the callers agree to follow. Two Sites exist
 * here for the same reason a single-Site fixture cannot prove isolation: the query has to be given a
 * real neighbour to leak from.
 */
describe("Media Site and Space isolation against PostgreSQL", () => {
  let siteA: PhiTestSite;
  let siteB: PhiTestSite;

  beforeAll(async () => {
    await dropPhiTestSites();
    siteA = await createPhiTestSite("isolation-a");
    siteB = await createPhiTestSite("isolation-b");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("does not return another Site's Asset by id", async () => {
    const assetId = await createPhiTestAsset(siteA, "pgtest/isolation-a");

    expect(await getMediaAssetBySiteAndId(siteA.id, assetId)).not.toBeNull();
    expect(await getMediaAssetBySiteAndId(siteB.id, assetId)).toBeNull();
  });

  it("does not return another Site's Assets from a list of ids", async () => {
    const own = await createPhiTestAsset(siteA, "pgtest/isolation-list-a");
    const foreign = await createPhiTestAsset(siteB, "pgtest/isolation-list-b");

    // The ids come from a Site's own Theme, which only says what the Site wrote, not what it owns.
    const assets = await getMediaAssetsByIds(siteA.id, [own, foreign]);
    expect([...assets.keys()]).toEqual([own]);
  });

  it("does not return an Asset from a Space it was not asked about", async () => {
    const assetId = await createPhiTestAsset(siteA, "pgtest/isolation-space");
    const otherSpaceId = await createPhiTestGroupSpace(siteA, 1_000);

    expect(await getMediaAssetBySiteAndId(siteA.id, assetId, siteA.siteSpaceId)).not.toBeNull();
    expect(await getMediaAssetBySiteAndId(siteA.id, assetId, otherSpaceId)).toBeNull();
  });

  it("does not return another Site's Space by id", async () => {
    expect(await getMediaSpaceById(siteA.id, siteA.siteSpaceId)).not.toBeNull();
    expect(await getMediaSpaceById(siteB.id, siteA.siteSpaceId)).toBeNull();
  });

  it("scopes duplicate detection to one Space", async () => {
    const pool = await requirePhiTestDatabase();
    const checksum = "b".repeat(64);
    const spaceId = await createPhiTestGroupSpace(siteA, 1_000);
    const inSiteSpace = await createPhiTestAsset(siteA, "pgtest/dup-site");
    const inGroupSpace = await createPhiTestAsset(siteA, "pgtest/dup-group");
    await pool.query(
      `UPDATE phis.media_assets SET checksum_algorithm = 'sha256', checksum_value = $2 WHERE id = ANY($1)`,
      [[inSiteSpace, inGroupSpace], checksum],
    );
    await pool.query(`UPDATE phis.media_assets SET space_id = $2 WHERE id = $1`, [inGroupSpace, spaceId]);

    // The same bytes in two Spaces are two Assets: custody differs, so one is not a duplicate of the other.
    expect((await getMediaAssetBySiteAndChecksum(siteA.id, siteA.siteSpaceId, { algorithm: 'sha256', value: checksum }))?.id).toBe(inSiteSpace);
    expect((await getMediaAssetBySiteAndChecksum(siteA.id, spaceId, { algorithm: 'sha256', value: checksum }))?.id).toBe(inGroupSpace);
    expect(await getMediaAssetBySiteAndChecksum(siteB.id, siteA.siteSpaceId, { algorithm: 'sha256', value: checksum })).toBeNull();
  });

  it("refuses to bind an Asset to a Storage Profile of another Site", async () => {
    const pool = await requirePhiTestDatabase();

    await expect(
      pool.query(
        `INSERT INTO phis.media_assets (site_id, space_id, storage_profile_id, storage_key, original_name, content_type)
         VALUES ($1, $2, $3, 'pgtest/cross-profile', 'cross.png', 'image/png')`,
        [siteA.id, siteA.siteSpaceId, siteB.storageProfileId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses to bind an Asset to a Space of another Site", async () => {
    const pool = await requirePhiTestDatabase();

    await expect(
      pool.query(
        `INSERT INTO phis.media_assets (site_id, space_id, storage_profile_id, storage_key, original_name, content_type)
         VALUES ($1, $2, $3, 'pgtest/cross-space', 'cross.png', 'image/png')`,
        [siteA.id, siteB.siteSpaceId, siteA.storageProfileId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("projects only Ready, Public Site Space Assets for internal reference resolution", async () => {
    const pool = await requirePhiTestDatabase();
    const groupSpaceId = await createPhiTestGroupSpace(siteA, 1_000);
    const ready = await createPhiTestAsset(siteA, "pgtest/projection-ready");
    const draft = await createPhiTestAsset(siteA, "pgtest/projection-draft");
    const authenticated = await createPhiTestAsset(siteA, "pgtest/projection-auth");
    const elsewhere = await createPhiTestAsset(siteA, "pgtest/projection-group");

    // lifecycle 2 is Ready, delivery policy 1 is Public, 2 is Authenticated.
    await pool.query(
      `UPDATE phis.media_assets SET lifecycle_status = 2, delivery_policy = 1 WHERE id = ANY($1)`,
      [[ready, authenticated, elsewhere]],
    );
    await pool.query(`UPDATE phis.media_assets SET delivery_policy = 2 WHERE id = $1`, [authenticated]);
    await pool.query(`UPDATE phis.media_assets SET space_id = $2 WHERE id = $1`, [elsewhere, groupSpaceId]);

    const projected = await listPublicSiteSpaceMediaAssetsByIds(
      siteA.id,
      [ready, draft, authenticated, elsewhere],
    );

    expect(projected.map((asset) => asset.id)).toEqual([ready]);
  });
});
