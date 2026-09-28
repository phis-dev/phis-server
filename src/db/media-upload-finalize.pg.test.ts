import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestGroupSpace,
  createPhiTestSite,
  createPhiTestUploadSession,
  createPhiTestUser,
  dropPhiTestSites,
  readPhiTestSpaceBytes,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { reserveMediaSpaceQuota } from "./media-spaces";
import { claimMediaUploadSessionForFinalize, createMediaAssetFromUploadSession } from "./media";
import { PhiMediaUploadSessionStatus } from "@/lib/media-upload-sessions";

/**
 * A finalize is taken once, and what it writes lands whole or not at all. The first is a race only the
 * database can referee; the second is a rollback only the database can perform.
 */
describe("finalizing an upload against PostgreSQL", () => {
  let site: PhiTestSite;
  let userId: number;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("finalize");
    userId = await createPhiTestUser(site);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function session(spaceId: number, sizeBytes = 300) {
    return createPhiTestUploadSession({
      site, spaceId, actorUserId: userId, sizeBytes, expiresInSeconds: 600,
    });
  }

  function assetInput(spaceId: number, storageKey: string) {
    return {
      siteId: site.id, spaceId, storageProfileId: site.storageProfileId, storageKey,
      originalName: "pgtest.png", contentType: "image/png", bytes: 300,
    };
  }

  async function assetsAt(storageKey: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query(
      `SELECT id FROM phis.media_assets WHERE storage_key = $1`,
      [storageKey],
    );
    return rows.length;
  }

  it("lets exactly one of two finalize requests take the session", async () => {
    const spaceId = await createPhiTestGroupSpace(site, 1_000);
    const token = await session(spaceId);

    const answers = await Promise.all([
      claimMediaUploadSessionForFinalize(token),
      claimMediaUploadSessionForFinalize(token),
    ]);
    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a proxied session whose body has not arrived", async () => {
    const spaceId = await createPhiTestGroupSpace(site, 1_000);
    const token = await session(spaceId);
    // The fixture writes `Uploading`; Core has not recorded the body yet.
    const claimed = await claimMediaUploadSessionForFinalize(token, PhiMediaUploadSessionStatus.Uploaded);
    expect(claimed).toBe(false);
  });

  it("creates the Asset and moves the reservation to used together", async () => {
    const spaceId = await createPhiTestGroupSpace(site, 1_000);
    await reserveMediaSpaceQuota({ spaceId, bytes: 300 });
    const token = await session(spaceId);
    const key = `pgtest/final/${token}`;

    const asset = await createMediaAssetFromUploadSession(token, assetInput(spaceId, key));

    expect(asset.storageKey).toBe(key);
    expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 300, reserved: 0 });
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query(
      `SELECT 1 FROM phis.media_upload_sessions WHERE token = $1`,
      [token],
    );
    expect(rows).toHaveLength(0);
  });

  it("leaves no Asset row behind when the reservation cannot be committed", async () => {
    const spaceId = await createPhiTestGroupSpace(site, 1_000);
    // Nothing reserved: the commit refuses, and the insert before it must go with it.
    const token = await session(spaceId);
    const key = `pgtest/final/${token}`;

    await expect(createMediaAssetFromUploadSession(token, assetInput(spaceId, key))).rejects.toThrow(
      /no longer available/,
    );
    expect(await assetsAt(key)).toBe(0);
    expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 0, reserved: 0 });
  });
});
