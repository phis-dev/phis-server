import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestAsset,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  getMediaAssetBySiteAndChecksum,
  listMediaAssetsWithoutIdentityChecksum,
  setMediaAssetChecksum,
} from "./media";

/**
 * Giving stored Assets a digest, and what has to be true while doing it.
 *
 * Two things only a database can answer. The selection has to be the *same* test the comparison makes -- an
 * Asset holding an `md5` is as invisible to duplicate detection as one holding nothing, and a recompute that
 * skipped it would leave it invisible forever. And writing a digest can reveal that two Assets hold the same
 * bytes, which is a fact with owners and references behind it: reporting it is this code's job, deciding about
 * it is not.
 */
const HEX = "b".repeat(64);
const OTHER = "c".repeat(64);

describe("recomputing digests against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("checksum-recompute");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function setAlgorithm(id: number, algorithm: string | null, value: string | null) {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `UPDATE phis.media_assets SET checksum_algorithm = $2, checksum_value = $3 WHERE id = $1`,
      [id, algorithm, value],
    );
  }

  it("selects the Assets duplicate detection cannot see, and only those", async () => {
    const none = await createPhiTestAsset(site, "objects/no-digest");
    const weak = await createPhiTestAsset(site, "objects/md5-only");
    const strong = await createPhiTestAsset(site, "objects/sha256");
    await setAlgorithm(weak, "md5", "d".repeat(32));
    await setAlgorithm(strong, "sha256", HEX);

    const { assets, remaining } = await listMediaAssetsWithoutIdentityChecksum(site.id, 50);
    const ids = assets.map((asset) => asset.id);
    // The weak digest is in: it proves a transfer intact and is never compared, which is the whole problem.
    expect(ids).toContain(none);
    expect(ids).toContain(weak);
    expect(ids).not.toContain(strong);
    expect(remaining).toBe(0);
    // Where the bytes are travels with them, because reading them is the only way to fix this.
    expect(assets.find((asset) => asset.id === none)?.storageKey).toBe("objects/no-digest");
  });

  it("says how many are left when it hands back a bounded page", async () => {
    const { assets, remaining } = await listMediaAssetsWithoutIdentityChecksum(site.id, 1);
    expect(assets).toHaveLength(1);
    // An operator needs to know whether to run it again rather than guessing from an empty answer.
    expect(remaining).toBeGreaterThan(0);
  });

  it("records a digest, and from then on the bytes are recognised", async () => {
    const id = await createPhiTestAsset(site, "objects/to-record");
    const written = await setMediaAssetChecksum({
      id, siteId: site.id, algorithm: "sha256", value: OTHER,
    });

    expect(written).toEqual({ duplicateOfAssetId: null });
    const found = await getMediaAssetBySiteAndChecksum(site.id, site.siteSpaceId, {
      algorithm: "sha256", value: OTHER,
    });
    expect(found?.id).toBe(id);
  });

  /*
   * The collision the recompute exists to surface. It is recorded rather than resolved: from now on an upload
   * of those bytes is refused as a duplicate, which is the point -- and which of the two Assets should go is a
   * decision with Folders, owners and references behind it.
   */
  it("reports that a digest now names another Asset in the same Space, without changing either", async () => {
    const first = await createPhiTestAsset(site, "objects/twin-a");
    const second = await createPhiTestAsset(site, "objects/twin-b");
    const twin = "e".repeat(64);

    expect(await setMediaAssetChecksum({ id: first, siteId: site.id, algorithm: "sha256", value: twin }))
      .toEqual({ duplicateOfAssetId: null });
    expect(await setMediaAssetChecksum({ id: second, siteId: site.id, algorithm: "sha256", value: twin }))
      .toEqual({ duplicateOfAssetId: first });

    // Both keep the digest: it is true of both, and the duplicate is a report rather than a rejection.
    const { assets } = await listMediaAssetsWithoutIdentityChecksum(site.id, 50);
    expect(assets.map((asset) => asset.id)).not.toContain(first);
    expect(assets.map((asset) => asset.id)).not.toContain(second);
  });

  it("does not report the row it is about to change as its own duplicate", async () => {
    const id = await createPhiTestAsset(site, "objects/rewritten");
    const value = "f".repeat(64);
    await setMediaAssetChecksum({ id, siteId: site.id, algorithm: "sha256", value });
    // Writing the same figure again is running it once, which is what makes the command safe to repeat.
    expect(await setMediaAssetChecksum({ id, siteId: site.id, algorithm: "sha256", value }))
      .toEqual({ duplicateOfAssetId: null });
  });

  it("answers null for an Asset of another Site rather than writing across one", async () => {
    const other = await createPhiTestSite("checksum-recompute-other");
    const id = await createPhiTestAsset(other, "objects/elsewhere");
    expect(await setMediaAssetChecksum({ id, siteId: site.id, algorithm: "sha256", value: HEX })).toBeNull();
  });
});
