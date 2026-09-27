import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { findResumableMediaUploadSession } from "./media";
import { PhiMediaUploadSessionStatus } from "@/lib/media-upload-sessions";

/**
 * Which interrupted upload an attempt is allowed to carry on, which only a database can answer.
 *
 * Every condition in that query is a guard, and a guard that goes is silent. Too narrow and resumption
 * simply never happens -- a person re-uploads a gigabyte and nobody learns why. Too wide and parts
 * somebody else's browser put there are joined to this body: the assembled object is then neither file,
 * and the digest Core records is recorded as true of it. So each one is stated here as its own case.
 */
const COMPOSITE_ALGORITHM = "sha256-composite";
const COMPOSITE = `${"a".repeat(64)}-2-16777216`;
const OTHER_COMPOSITE = `${"b".repeat(64)}-2-16777216`;
const SIZE_BYTES = 20 * 1024 * 1024;

describe("finding the upload an attempt may carry on", () => {
  let site: PhiTestSite;
  let actorUserId: number;
  let strangerUserId: number;
  let sequence = 0;

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("upload-resume");
    actorUserId = await createPhiTestUser(site);
    strangerUserId = await createPhiTestUser(site);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  /*
   * Every case here is about what is *not* offered, so each one starts with nothing else to find --
   * otherwise a passing decoy test would only be proving that the valid row from an earlier case is gone.
   */
  beforeEach(async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.media_upload_sessions WHERE site_id = $1`, [site.id]);
  });

  /**
   * Inserted rather than created through `createMediaUploadSession`, because what is under test is the
   * selection and the interesting rows are the ones a session is *not* normally left in.
   */
  async function insertSession(overrides: {
    status?: number;
    planKind?: number;
    actorUserId?: number;
    filename?: string;
    sizeBytes?: number;
    checksumValue?: string | null;
    checksumAlgorithm?: string | null;
    expiresInSeconds?: number;
    spaceId?: number;
  } = {}) {
    const pool = await requirePhiTestDatabase();
    sequence += 1;
    const token = `pgtest-resume-${process.pid}-${sequence}`;
    const planKind = overrides.planKind ?? 3;
    await pool.query(
      `INSERT INTO phis.media_upload_sessions (
         token, site_id, actor_user_id, space_id, storage_profile_id, status,
         filename, content_type, size_bytes, kind, upload_plan_kind,
         checksum_algorithm, checksum_value, staging_storage_key, provider_upload_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'video/mp4', $8, 'video', $9, $10, $11, $12, $13,
                 NOW() + make_interval(secs => $14))`,
      [
        token, site.id, overrides.actorUserId ?? actorUserId, overrides.spaceId ?? site.siteSpaceId,
        site.storageProfileId, overrides.status ?? PhiMediaUploadSessionStatus.Interrupted,
        overrides.filename ?? "clip.mp4", overrides.sizeBytes ?? SIZE_BYTES, planKind,
        overrides.checksumAlgorithm === undefined ? COMPOSITE_ALGORITHM : overrides.checksumAlgorithm,
        overrides.checksumValue === undefined ? COMPOSITE : overrides.checksumValue,
        `pgtest/staging/${token}`,
        // The schema ties this to the plan kind: an assembly has a name at the Provider, nothing else does.
        planKind === 3 ? `upload-${token}` : null,
        overrides.expiresInSeconds ?? 3600,
      ],
    );
    return token;
  }

  function look(overrides: Record<string, unknown> = {}) {
    return findResumableMediaUploadSession({
      siteId: site.id,
      spaceId: site.siteSpaceId,
      actorUserId,
      filename: "clip.mp4",
      sizeBytes: SIZE_BYTES,
      checksumAlgorithm: COMPOSITE_ALGORITHM,
      checksumValue: COMPOSITE,
      ...overrides,
    } as Parameters<typeof findResumableMediaUploadSession>[0]);
  }

  it("finds the interrupted assembly of this file, with what it takes to carry it on", async () => {
    const token = await insertSession();
    const found = await look();

    expect(found?.token).toBe(token);
    // Both of these are the continuation: where the parts are, and what the Provider calls the assembly.
    expect(found?.stagingStorageKey).toBe(`pgtest/staging/${token}`);
    expect(found?.providerUploadId).toBe(`upload-${token}`);
  });

  it("does not offer a session that never said it stopped", async () => {
    // Pending or Uploading may have a page sending into it right now, and two pages writing the same part
    // numbers would leave whichever finalized second holding a session that is already gone.
    for (const status of [
      PhiMediaUploadSessionStatus.Pending,
      PhiMediaUploadSessionStatus.Uploading,
      PhiMediaUploadSessionStatus.Uploaded,
      PhiMediaUploadSessionStatus.Completed,
    ]) {
      await insertSession({ status });
      expect(await look()).toBeNull();
    }
  });

  it("does not offer a body that was never divided", async () => {
    // A single PUT that stopped halfway wrote bytes nobody attested and nobody can name.
    await insertSession({ planKind: 2 });
    expect(await look()).toBeNull();
  });

  it("does not offer another person's parts", async () => {
    await insertSession({ actorUserId: strangerUserId });
    expect(await look()).toBeNull();
  });

  it("does not offer a session whose digest is a different file", async () => {
    await insertSession({ checksumValue: OTHER_COMPOSITE });
    expect(await look()).toBeNull();
  });

  it("does not offer a session that recorded no digest at all", async () => {
    await insertSession({ checksumAlgorithm: null, checksumValue: null });
    expect(await look()).toBeNull();
  });

  it("does not offer the same bytes under another name, because the Asset takes the name", async () => {
    await insertSession({ filename: "clip-final.mp4" });
    expect(await look()).toBeNull();
  });

  it("does not offer a session whose window has closed", async () => {
    // Its reservation is already forfeit, and the sweep is what removes it; carrying it on would build on
    // a row the next upload into this Space is about to delete.
    await insertSession({ expiresInSeconds: -60 });
    expect(await look()).toBeNull();
  });

  /*
   * The purpose decides what the finished object becomes. Taking over a session reserved for an Add-on's
   * row would finalize somebody else's slot into a Media Asset, so the condition is stated rather than
   * left to the fact that no Add-on asks for an assembly today.
   */
  it("does not offer a session reserved for something other than a Media Asset", async () => {
    const pool = await requirePhiTestDatabase();
    const token = await insertSession();
    await pool.query(
      `UPDATE phis.media_upload_sessions
          SET purpose = 2, purpose_ref = '{"addonId":"@pgtest/x","table":"t","ownerId":"1","slot":"s"}'::jsonb
        WHERE token = $1`,
      [token],
    );
    expect(await look()).toBeNull();
  });

  it("offers the most recent one where the same file was interrupted twice", async () => {
    const pool = await requirePhiTestDatabase();
    const first = await insertSession();
    // Aged deliberately, so the ordering is the thing under test rather than two timestamps a microsecond
    // apart. Either row would in fact be a valid continuation of the same body; the later one simply has
    // more parts at the Provider, and the earlier expires on its own.
    await pool.query(
      `UPDATE phis.media_upload_sessions SET created_at = NOW() - INTERVAL '1 hour' WHERE token = $1`,
      [first],
    );
    const second = await insertSession();
    expect((await look())?.token).toBe(second);
  });
});
