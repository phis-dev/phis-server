import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { createTotpCode, createTotpSecret } from "@/lib/site-auth/totp";
import { encryptAuthTransactionPayload } from "@/lib/site-auth/transaction-crypto";
import { PHI_AUTH_FACTOR_TYPES, verifyConfirmedTotpFactor } from "./user-auth-factors";

/**
 * A code is spent by the step it belongs to, and the spending is one statement against the row. Only
 * PostgreSQL decides whether two requests carrying the same code can both win, which is why this runs
 * against it rather than against a fake that would accept whatever order the test chose.
 */
describe("TOTP codes against PostgreSQL", () => {
  let site: PhiTestSite;
  let userId: number;
  let secret: Buffer;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("totp");
    userId = await createPhiTestUser(site);
    // A confirmed factor with a secret this test knows, written the way enrolment writes one.
    secret = createTotpSecret().secret;
    const encrypted = encryptAuthTransactionPayload({ secretHex: secret.toString("hex") });
    await pool.query(
      `INSERT INTO phis.user_auth_factors (
         id, user_id, site_id, factor_type, secret_ciphertext, secret_iv, secret_auth_tag, label,
         confirmed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pgtest', NOW())`,
      [
        randomUUID(), userId, site.id, PHI_AUTH_FACTOR_TYPES.totp,
        encrypted.ciphertextHex, encrypted.ivHex, encrypted.authTagHex,
      ],
    );
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("accepts a code once and never the same code again", async () => {
    const code = createTotpCode(secret);
    expect(await verifyConfirmedTotpFactor({ userId, siteId: site.id, code })).toBe(true);
    // Still inside the window the code is valid in, and refused all the same: it has been spent.
    expect(await verifyConfirmedTotpFactor({ userId, siteId: site.id, code })).toBe(false);
  });

  it("refuses an older step after a newer one, and takes the next step", async () => {
    // The previous period's code fits the window, but a later step has already been accepted.
    expect(await verifyConfirmedTotpFactor({
      userId, siteId: site.id, code: createTotpCode(secret, Date.now() - 30_000),
    })).toBe(false);
    expect(await verifyConfirmedTotpFactor({
      userId, siteId: site.id, code: createTotpCode(secret, Date.now() + 30_000),
    })).toBe(true);
  });

  it("lets only one of two requests racing for the same code through", async () => {
    // A fresh step that nothing above has spent yet: two periods ahead is outside the window, so the
    // race is staged at a time when it is inside one.
    const later = Date.now() + 60_000;
    const code = createTotpCode(secret, later);
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `UPDATE phis.user_auth_factors SET factor_data = '{}'::jsonb WHERE user_id = $1 AND site_id = $2`,
      [userId, site.id],
    );
    const answers = await Promise.all([
      verifyConfirmedTotpFactor({ userId, siteId: site.id, code, now: later }),
      verifyConfirmedTotpFactor({ userId, siteId: site.id, code, now: later }),
    ]);
    expect(answers.filter(Boolean)).toHaveLength(1);
  });
});
