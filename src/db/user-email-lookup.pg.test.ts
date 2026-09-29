import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { createRegistrationIntent } from "./registration-intents";
import { ensureUserAccount, getUserAccountByEmail } from "./user-accounts";

/**
 * Every address in `user_emails` is its account's and nobody else's. The lookup asked only the primary
 * one, so a taken address read as free: registering it ended in the unique index, its owner could not
 * sign in with it, and returning to it was refused as though it were somebody else's.
 */
describe("finding an account by any of its addresses against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("email-lookup");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function withFormerAddress(userId: number) {
    const pool = await requirePhiTestDatabase();
    const former = `pgtest-former-${userId}-${Math.random().toString(36).slice(2)}@example.test`;
    await pool.query(
      `INSERT INTO phis.user_emails (user_id, email_normalized, verified_at, flags, source)
       VALUES ($1, $2, NOW(), 0, 1)`,
      [userId, former],
    );
    const { rows } = await pool.query<{ email_normalized: string }>(
      `SELECT email_normalized FROM phis.user_emails WHERE user_id = $1 AND (flags & 1) <> 0`,
      [userId],
    );
    return { former, primary: rows[0]!.email_normalized };
  }

  it("answers with the owner for an address that is not the primary one, and names the primary", async () => {
    const userId = await createPhiTestUser(site);
    const { former, primary } = await withFormerAddress(userId);

    const account = await getUserAccountByEmail(former, site.id);

    expect(account?.id).toBe(userId);
    expect(account?.emailNormalized).toBe(primary);
  });

  it("lets an account return to an address it held before", async () => {
    const userId = await createPhiTestUser(site);
    const { former } = await withFormerAddress(userId);

    await expect(createRegistrationIntent({
      siteId: site.id, userId, email: former, locale: "en", newsletterOptIn: false,
    })).resolves.toMatchObject({ email: former });
  });

  it("keeps another account's former address from anyone else", async () => {
    const owner = await createPhiTestUser(site);
    const other = await createPhiTestUser(site);
    const { former } = await withFormerAddress(owner);

    await expect(createRegistrationIntent({
      siteId: site.id, userId: other, email: former, locale: "en", newsletterOptIn: false,
    })).rejects.toThrow("ACCOUNT_EXISTS");
    await expect(ensureUserAccount({
      email: former, siteId: site.id, emailSource: 1, reuseExisting: false,
    } as Parameters<typeof ensureUserAccount>[0])).rejects.toThrow("ACCOUNT_EXISTS");
  });
});
