import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { decryptRegistrationPassword, encryptRegistrationPassword } from "@/lib/registration-secret";
import { createRegistrationIntent, getRegistrationIntentByVerificationToken } from "./registration-intents";

/**
 * A registration intent keeps the SHA-256 of its link token and the AES-256-GCM sealed password as bytes.
 * The way back is the whole point: the token in the mailed link finds the row, and the password comes out
 * of the three stored parts unchanged.
 */
describe("registration intent storage against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("intent-storage");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("finds the intent by its link token and recovers the password", async () => {
    const created = await createRegistrationIntent({
      siteId: site.id,
      email: "pgtest-intent-storage@example.test",
      firstName: "Paula",
      lastName: "Person",
      password: "long-enough-ü-1",
      locale: "en",
      newsletterOptIn: false,
    });

    const found = await getRegistrationIntentByVerificationToken(site.id, created.verificationToken);
    expect(found?.id).toBe(created.id);
    expect(decryptRegistrationPassword({
      ciphertext: found!.passwordCiphertext!, iv: found!.passwordIv!, authTag: found!.passwordAuthTag!,
    })).toBe("long-enough-ü-1");
    expect(await getRegistrationIntentByVerificationToken(site.id, `${created.verificationToken}0`)).toBeNull();

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ hash: Buffer; iv: number; tag: number }>(
      `SELECT verification_token_hash AS hash, octet_length(password_iv) AS iv, octet_length(password_auth_tag) AS tag
       FROM phis.registration_intents WHERE id = $1`,
      [created.id],
    );
    expect(rows[0]!.hash).toEqual(createHash("sha256").update(created.verificationToken).digest());
    expect(rows[0]).toMatchObject({ iv: 12, tag: 16 });
  });

  it("still finds an intent whose token hash and password were stored as hex text before the conversion", async () => {
    const token = "cd".repeat(32);
    const sealed = encryptRegistrationPassword("legacy-password-1");
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.registration_intents (
         site_id, email, first_name, last_name, password_ciphertext, password_iv, password_auth_tag,
         locale, verification_token_hash, verification_token_expires_at
       ) VALUES (
         $1, 'pgtest-intent-legacy@example.test', 'Lea', 'Legacy',
         decode($2, 'hex'), decode($3, 'hex'), decode($4, 'hex'),
         'en', decode($5, 'hex'), NOW() + INTERVAL '1 day'
       )`,
      [
        site.id,
        sealed.ciphertext.toString("hex"), sealed.iv.toString("hex"), sealed.authTag.toString("hex"),
        createHash("sha256").update(token).digest("hex"),
      ],
    );

    const found = await getRegistrationIntentByVerificationToken(site.id, token);
    expect(found).not.toBeNull();
    expect(decryptRegistrationPassword({
      ciphertext: found!.passwordCiphertext!, iv: found!.passwordIv!, authTag: found!.passwordAuthTag!,
    })).toBe("legacy-password-1");
  });
});
