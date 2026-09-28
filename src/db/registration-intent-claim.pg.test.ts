import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  claimRegistrationIntent,
  consumeRegistrationIntent,
  createRegistrationIntent,
  getRegistrationIntentByVerificationToken,
  REGISTRATION_INTENT_STATUS_PENDING,
  releaseRegistrationIntentClaim,
} from "./registration-intents";

/**
 * One confirmation acts on a registration link, and a confirmation that stopped short gives it back.
 * Both are single statements whose answer depends on what PostgreSQL decides for racing requests.
 */
describe("claiming a registration intent against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("intent-claim");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  function intent() {
    return createRegistrationIntent({
      siteId: site.id,
      email: `pgtest-${Math.random().toString(36).slice(2)}@example.test`,
      firstName: "Paula",
      lastName: "Person",
      companyName: null,
      password: "long-enough-1",
      locale: "en",
      newsletterOptIn: false,
    });
  }

  it("lets exactly one of two confirmations take the link", async () => {
    const { id } = await intent();
    const answers = await Promise.all([claimRegistrationIntent(id), claimRegistrationIntent(id)]);
    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it("gives the link back when the confirmation stopped before consuming it", async () => {
    const created = await intent();
    expect(await claimRegistrationIntent(created.id)).toBe(true);
    await releaseRegistrationIntentClaim(created.id);

    const row = await getRegistrationIntentByVerificationToken(site.id, created.verificationToken);
    expect(row?.status).toBe(REGISTRATION_INTENT_STATUS_PENDING);
    expect(await claimRegistrationIntent(created.id)).toBe(true);
  });

  it("leaves a consumed intent consumed", async () => {
    const created = await intent();
    expect(await claimRegistrationIntent(created.id)).toBe(true);
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.user_accounts (flags) VALUES (0) RETURNING id`,
    );
    await consumeRegistrationIntent(created.id, rows[0]!.id);
    await releaseRegistrationIntentClaim(created.id);

    expect(await claimRegistrationIntent(created.id)).toBe(false);
    await pool.query(`DELETE FROM phis.user_accounts WHERE id = $1`, [rows[0]!.id]);
  });
});
