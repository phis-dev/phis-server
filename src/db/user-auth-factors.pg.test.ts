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
import { decryptAuthTransactionPayload, encryptAuthTransactionPayload } from "@/lib/site-auth/transaction-crypto";
import {
  confirmPendingTotpFactor,
  createPendingTotpFactor,
  PHI_AUTH_FACTOR_TYPES,
  verifyConfirmedTotpFactor,
} from "./user-auth-factors";

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
        encrypted.ciphertext, encrypted.iv, encrypted.authTag,
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

  it("enrols, confirms and verifies a factor through the encrypted bytea columns", async () => {
    const enrolled = await createPhiTestUser(site);
    const { id } = await createPendingTotpFactor({ userId: enrolled, siteId: site.id });
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{
      secret_ciphertext: Buffer; secret_iv: Buffer; secret_auth_tag: Buffer;
    }>(
      `SELECT secret_ciphertext, secret_iv, secret_auth_tag FROM phis.user_auth_factors WHERE id = $1`,
      [id],
    );
    // AES-256-GCM: a 12-byte initialization vector and a 16-byte tag.
    expect(rows[0]!.secret_iv).toHaveLength(12);
    expect(rows[0]!.secret_auth_tag).toHaveLength(16);
    const stored = decryptAuthTransactionPayload({
      ciphertext: rows[0]!.secret_ciphertext, iv: rows[0]!.secret_iv, authTag: rows[0]!.secret_auth_tag,
    });
    const enrolledSecret = Buffer.from(stored.secretHex as string, "hex");

    expect(await confirmPendingTotpFactor({
      factorId: id, userId: enrolled, siteId: site.id, code: createTotpCode(enrolledSecret),
    })).not.toBeNull();
    expect(await verifyConfirmedTotpFactor({
      userId: enrolled, siteId: site.id, code: createTotpCode(enrolledSecret, Date.now() + 30_000),
    })).toBe(true);
  });

  it("verifies a factor that was stored as hex text before the conversion", async () => {
    const legacy = await createPhiTestUser(site);
    const legacySecret = createTotpSecret().secret;
    const encrypted = encryptAuthTransactionPayload({ secretHex: legacySecret.toString("hex") });
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.user_auth_factors (
         id, user_id, site_id, factor_type, secret_ciphertext, secret_iv, secret_auth_tag, label,
         confirmed_at
       ) VALUES ($1, $2, $3, $4, decode($5, 'hex'), decode($6, 'hex'), decode($7, 'hex'), 'pgtest', NOW())`,
      [
        randomUUID(), legacy, site.id, PHI_AUTH_FACTOR_TYPES.totp,
        encrypted.ciphertext.toString("hex"), encrypted.iv.toString("hex"), encrypted.authTag.toString("hex"),
      ],
    );
    expect(await verifyConfirmedTotpFactor({
      userId: legacy, siteId: site.id, code: createTotpCode(legacySecret),
    })).toBe(true);
  });
});
