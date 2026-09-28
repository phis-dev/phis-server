import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  claimUserPasswordResetToken,
  createUserPasswordResetToken,
  getUserPasswordResetTokenByRawToken,
} from "./user-password-reset-tokens";

/**
 * A reset link works once, and only the newest one works. Both are single statements whose answer
 * depends on what PostgreSQL decides when two requests arrive together.
 */
describe("password reset tokens against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("reset-tokens");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("retires the older links when a new one is asked for", async () => {
    const userId = await createPhiTestUser(site);
    const first = await createUserPasswordResetToken({ userId, siteId: site.id });
    const second = await createUserPasswordResetToken({ userId, siteId: site.id });

    const older = await getUserPasswordResetTokenByRawToken(site.id, first.token);
    const newer = await getUserPasswordResetTokenByRawToken(site.id, second.token);
    expect(older?.consumedAt).not.toBeNull();
    expect(newer?.consumedAt).toBeNull();
    expect(await claimUserPasswordResetToken(older!.id)).toBe(false);
    expect(await claimUserPasswordResetToken(newer!.id)).toBe(true);
  });

  it("lets only one of two requests with the same link set a password", async () => {
    const userId = await createPhiTestUser(site);
    const { token } = await createUserPasswordResetToken({ userId, siteId: site.id });
    const row = await getUserPasswordResetTokenByRawToken(site.id, token);

    const answers = await Promise.all([
      claimUserPasswordResetToken(row!.id),
      claimUserPasswordResetToken(row!.id),
    ]);
    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it("does not take an expired link", async () => {
    const userId = await createPhiTestUser(site);
    const { token } = await createUserPasswordResetToken({ userId, siteId: site.id });
    const row = await getUserPasswordResetTokenByRawToken(site.id, token);
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `UPDATE phis.user_password_reset_tokens SET expires_at = NOW() - INTERVAL '1 minute'
       WHERE id = $1`,
      [row!.id],
    );
    expect(await claimUserPasswordResetToken(row!.id)).toBe(false);
  });

  it("leaves another account's link alone", async () => {
    const one = await createPhiTestUser(site);
    const other = await createPhiTestUser(site);
    const kept = await createUserPasswordResetToken({ userId: other, siteId: site.id });
    await createUserPasswordResetToken({ userId: one, siteId: site.id });

    expect((await getUserPasswordResetTokenByRawToken(site.id, kept.token))?.consumedAt).toBeNull();
  });
});
