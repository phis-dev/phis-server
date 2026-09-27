import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestGroupSpace,
  createPhiTestUploadSession,
  createPhiTestUserSpace,
  createPhiTestUser,
  dropPhiTestSites,
  readPhiTestSpaceBytes,
  requirePhiTestDatabase,
  setPhiTestMediaConfig,
  type PhiTestSite,
} from "../../test/pg/harness";
import { reserveMediaSpaceQuota, releaseMediaSpaceReservation } from "./media-spaces";
import {
  abortMediaUploadSessionByToken,
  commitMediaUploadSessionByToken,
  releaseExpiredMediaUploadSessions,
} from "./media";

/**
 * Quota accounting is the one place in the Media core where two requests race for the same number.
 * A fake cannot decide any of it: whether the reservation is really one atomic statement, whether an
 * expired session's bytes stop standing in the way, and whether the same bytes can be subtracted
 * twice. These run against PostgreSQL and its concurrency, which is the only authority on all three.
 */
describe("Media quota accounting against PostgreSQL", () => {
  let site: PhiTestSite;
  let userId: number;

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("quota");
    userId = await createPhiTestUser(site);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  describe("reservation", () => {
    it("accepts a reservation that fits exactly", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);

      expect(await reserveMediaSpaceQuota({ spaceId, bytes: 1_000 })).toBe(true);
      expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 0, reserved: 1_000 });
    });

    it("refuses a reservation one byte over and changes nothing", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);

      expect(await reserveMediaSpaceQuota({ spaceId, bytes: 1_001 })).toBe(false);
      expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 0, reserved: 0 });
    });

    it("counts used and reserved bytes against the same allowance", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      const pool = await requirePhiTestDatabase();
      await pool.query(`UPDATE phis.media_spaces SET used_bytes = 600 WHERE id = $1`, [spaceId]);

      expect(await reserveMediaSpaceQuota({ spaceId, bytes: 400 })).toBe(true);
      expect(await reserveMediaSpaceQuota({ spaceId, bytes: 1 })).toBe(false);
    });

    it("inherits the Site default when the Space carries no override", async () => {
      await setPhiTestMediaConfig(site, { defaultGroupQuotaBytes: 500 });
      const spaceId = await createPhiTestGroupSpace(site);

      expect(await reserveMediaSpaceQuota({ spaceId, bytes: 501 })).toBe(false);
      expect(await reserveMediaSpaceQuota({ spaceId, bytes: 500 })).toBe(true);
    });

    it("lets a Space override raise the allowance above the Site default", async () => {
      await setPhiTestMediaConfig(site, { defaultGroupQuotaBytes: 500 });
      const spaceId = await createPhiTestGroupSpace(site, 2_000);

      expect(await reserveMediaSpaceQuota({ spaceId, bytes: 2_000 })).toBe(true);
    });

    // Two billion rather than something larger: the reservation passes its byte count as an untyped
    // parameter, so PostgreSQL infers `integer` and anything past 2^31 fails in the driver. Nothing
    // can reach that today -- `max_object_bytes` caps a single upload far below it -- but a Space
    // holding terabytes would need the parameter cast before this statement could count it.
    it("treats a Site Space without an override as unlimited", async () => {
      expect(await reserveMediaSpaceQuota({ spaceId: site.siteSpaceId, bytes: 2_000_000_000 })).toBe(true);
      await releaseMediaSpaceReservation({ spaceId: site.siteSpaceId, bytes: 2_000_000_000 });
    });

    // The decisive one: two requests that each fit alone but not together. If the read and the write
    // were separate statements, both would see room and the Space would end up over its quota.
    it("lets only one of two concurrent reservations through", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);

      const outcomes = await Promise.all([
        reserveMediaSpaceQuota({ spaceId, bytes: 600 }),
        reserveMediaSpaceQuota({ spaceId, bytes: 600 }),
      ]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 0, reserved: 600 });
    });

    it("never drives reserved bytes below zero on an over-release", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      await reserveMediaSpaceQuota({ spaceId, bytes: 100 });

      await releaseMediaSpaceReservation({ spaceId, bytes: 900 });

      expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 0, reserved: 0 });
    });
  });

  describe("expiry", () => {
    it("releases an expired session and subtracts exactly its bytes", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      await reserveMediaSpaceQuota({ spaceId, bytes: 400 });
      await createPhiTestUploadSession({ site, spaceId, actorUserId: userId, sizeBytes: 400, expiresInSeconds: -60 });

      expect(await releaseExpiredMediaUploadSessions(spaceId)).toHaveLength(1);
      expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 0, reserved: 0 });
    });

    it("leaves a live session alone", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      await reserveMediaSpaceQuota({ spaceId, bytes: 400 });
      await createPhiTestUploadSession({ site, spaceId, actorUserId: userId, sizeBytes: 400, expiresInSeconds: 600 });

      expect(await releaseExpiredMediaUploadSessions(spaceId)).toHaveLength(0);
      expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 0, reserved: 400 });
    });

    it("subtracts nothing on a second pass", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      await reserveMediaSpaceQuota({ spaceId, bytes: 400 });
      await createPhiTestUploadSession({ site, spaceId, actorUserId: userId, sizeBytes: 400, expiresInSeconds: -60 });

      await releaseExpiredMediaUploadSessions(spaceId);
      expect(await releaseExpiredMediaUploadSessions(spaceId)).toHaveLength(0);
      expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 0, reserved: 0 });
    });

    // What the read-time discount is for: an abandoned session must not keep the capacity it is no
    // longer entitled to, even before anything has collected it.
    it("does not let an expired session block a new reservation", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      await reserveMediaSpaceQuota({ spaceId, bytes: 800 });
      await createPhiTestUploadSession({ site, spaceId, actorUserId: userId, sizeBytes: 800, expiresInSeconds: -60 });

      expect(await reserveMediaSpaceQuota({ spaceId, bytes: 900 })).toBe(true);
    });

    it("still counts a live session against a new reservation", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      await reserveMediaSpaceQuota({ spaceId, bytes: 800 });
      await createPhiTestUploadSession({ site, spaceId, actorUserId: userId, sizeBytes: 800, expiresInSeconds: 600 });

      expect(await reserveMediaSpaceQuota({ spaceId, bytes: 900 })).toBe(false);
    });

    it("only collects sessions of the Space it was asked about", async () => {
      const own = await createPhiTestGroupSpace(site, 1_000);
      const other = await createPhiTestUserSpace(site, 1_000);
      await reserveMediaSpaceQuota({ spaceId: own, bytes: 100 });
      await reserveMediaSpaceQuota({ spaceId: other, bytes: 100 });
      await createPhiTestUploadSession({ site, spaceId: own, actorUserId: userId, sizeBytes: 100, expiresInSeconds: -60 });
      await createPhiTestUploadSession({ site, spaceId: other, actorUserId: userId, sizeBytes: 100, expiresInSeconds: -60 });

      expect(await releaseExpiredMediaUploadSessions(own)).toHaveLength(1);
      expect(await readPhiTestSpaceBytes(other)).toEqual({ used: 0, reserved: 100 });
    });
  });

  describe("commit", () => {
    it("moves reserved bytes to used and removes the session in one transaction", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      await reserveMediaSpaceQuota({ spaceId, bytes: 300 });
      const token = await createPhiTestUploadSession({ site, spaceId, actorUserId: userId, sizeBytes: 300, expiresInSeconds: 600 });

      await commitMediaUploadSessionByToken(token);

      expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 300, reserved: 0 });
      const pool = await requirePhiTestDatabase();
      const { rows } = await pool.query(`SELECT token FROM phis.media_upload_sessions WHERE token = $1`, [token]);
      expect(rows).toHaveLength(0);
    });

    // The window this closes: while the row exists its bytes are reserved, once it is gone they are
    // used. If expiry could still see a committed session, it would subtract bytes that now belong to
    // whoever reserved next.
    it("leaves nothing for the expiry pass to subtract a second time", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      await reserveMediaSpaceQuota({ spaceId, bytes: 300 });
      const token = await createPhiTestUploadSession({ site, spaceId, actorUserId: userId, sizeBytes: 300, expiresInSeconds: -60 });

      await commitMediaUploadSessionByToken(token);

      expect(await releaseExpiredMediaUploadSessions(spaceId)).toHaveLength(0);
      expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 300, reserved: 0 });
    });

    it("refuses to commit more than the Space has reserved", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      const token = await createPhiTestUploadSession({ site, spaceId, actorUserId: userId, sizeBytes: 300, expiresInSeconds: 600 });

      await expect(commitMediaUploadSessionByToken(token)).rejects.toThrow();
      expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 0, reserved: 0 });
    });

    it("releases the reservation when an abandoned session is aborted", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      await reserveMediaSpaceQuota({ spaceId, bytes: 300 });
      const token = await createPhiTestUploadSession({ site, spaceId, actorUserId: userId, sizeBytes: 300, expiresInSeconds: 600 });

      await abortMediaUploadSessionByToken(token);
      // Idempotent: a retried abort finds no row and must not free someone else's bytes.
      await abortMediaUploadSessionByToken(token);

      expect(await readPhiTestSpaceBytes(spaceId)).toEqual({ used: 0, reserved: 0 });
    });
  });
});
