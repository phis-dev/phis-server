import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PHI_CORE_ROLE_PROVIDER_ID,
  PhiBaseRole,
  PhiUserEmailFlag,
  PhiUserEmailSource,
} from "@phis/contracts/access";

import {
  grantPhiCliSiteAdmin,
  listPhiCliSiteAdmins,
  revokePhiCliSiteAdmin,
  setPhiCliUserPassword,
} from "@/db/cli-site-admins.mts";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * The operator's way into a Site that has nobody in it.
 *
 * Every path that hands out the Admin role needs somebody who already holds it, which leaves a fresh
 * Site with a login form and no account that could pass it. These are the tests for the one door that
 * opens from outside that circle -- and for the two things it must not do on the way through: replace a
 * credential that is not this Site's to replace, and drop roles somebody was granted elsewhere.
 */

let site: PhiTestSite;
let other: PhiTestSite;

beforeAll(async () => {
  await requirePhiTestDatabase();
  site = await createPhiTestSite("cli-admin");
  other = await createPhiTestSite("cli-admin-other");
});

afterAll(async () => {
  await dropPhiTestSites();
  await closePhiTestPool();
});

describe("granting the Admin role from the CLI", () => {
  it("creates the account, its primary address and the claim in one go", async () => {
    const pool = await requirePhiTestDatabase();
    const email = `${site.key}-first@example.invalid`;

    const grant = await grantPhiCliSiteAdmin(pool, {
      siteId: site.id,
      email,
      passwordHash: "hash-one",
      firstName: "Ada",
      lastName: "Lovelace",
    });

    expect(grant.accountCreated).toBe(true);
    expect(grant.passwordSet).toBe(true);
    expect(grant.alreadyAdmin).toBe(false);

    const { rows } = await pool.query<{ flags: number; source: number }>(
      `SELECT flags, source FROM phis.user_emails WHERE email_normalized = $1`,
      [email],
    );
    expect(rows[0]!.flags & PhiUserEmailFlag.Primary).toBe(PhiUserEmailFlag.Primary);
    // The origin is what nobody can reconstruct afterwards, and an operator-made account says so.
    expect(rows[0]!.source).toBe(PhiUserEmailSource.Operator);

    const admins = await listPhiCliSiteAdmins(pool, site.id);
    expect(admins.map((entry) => entry.email)).toContain(email);
    expect(admins.find((entry) => entry.email === email)?.lastName).toBe("Lovelace");
  });

  it("adds Admin to the roles somebody already has instead of replacing them", async () => {
    const pool = await requirePhiTestDatabase();
    const email = `${site.key}-author@example.invalid`;

    await grantPhiCliSiteAdmin(pool, { siteId: site.id, email, passwordHash: "hash-two" });
    await revokePhiCliSiteAdmin(pool, { siteId: site.id, email });
    const { rows: created } = await pool.query<{ user_id: number }>(
      `SELECT user_id FROM phis.user_emails WHERE email_normalized = $1`,
      [email],
    );
    const userId = created[0]!.user_id;
    await pool.query(
      `INSERT INTO phis.user_site_role_claims (user_id, site_id, provider_id, role_flags)
       VALUES ($1, $2, $3, $4)`,
      [userId, site.id, PHI_CORE_ROLE_PROVIDER_ID, PhiBaseRole.Author],
    );

    await grantPhiCliSiteAdmin(pool, { siteId: site.id, email, passwordHash: "ignored" });

    const { rows } = await pool.query<{ role_flags: number }>(
      `SELECT role_flags FROM phis.user_site_role_claims
       WHERE user_id = $1 AND site_id = $2 AND provider_id = $3`,
      [userId, site.id, PHI_CORE_ROLE_PROVIDER_ID],
    );
    expect(rows[0]!.role_flags).toBe(PhiBaseRole.Author | PhiBaseRole.Admin);
  });

  it("leaves an existing account's password alone", async () => {
    const pool = await requirePhiTestDatabase();
    const email = `${site.key}-kept@example.invalid`;

    await grantPhiCliSiteAdmin(pool, { siteId: site.id, email, passwordHash: "original" });
    const second = await grantPhiCliSiteAdmin(pool, {
      siteId: other.id,
      email,
      passwordHash: "would-overwrite",
    });

    expect(second.accountCreated).toBe(false);
    expect(second.passwordSet).toBe(false);
    const { rows } = await pool.query<{ password_hash: string }>(
      `SELECT p.password_hash
       FROM phis.user_password_credentials p
       JOIN phis.user_emails e ON e.user_id = p.user_id
       WHERE e.email_normalized = $1`,
      [email],
    );
    expect(rows[0]!.password_hash).toBe("original");
  });

  it("reports an account that already held the role", async () => {
    const pool = await requirePhiTestDatabase();
    const email = `${site.key}-twice@example.invalid`;

    await grantPhiCliSiteAdmin(pool, { siteId: site.id, email, passwordHash: "hash" });
    const again = await grantPhiCliSiteAdmin(pool, { siteId: site.id, email, passwordHash: "hash" });

    expect(again.alreadyAdmin).toBe(true);
  });

  /**
   * `user_site_role_claims` holds `CHECK (role_flags > 0)`: a claim granting nothing is not a statement
   * about anybody. Removing the last role is therefore a deletion, and getting that wrong fails loudly
   * rather than quietly leaving an empty row.
   */
  it("deletes the claim when Admin was the only role, and keeps it when it was not", async () => {
    const pool = await requirePhiTestDatabase();
    const soleEmail = `${site.key}-sole@example.invalid`;
    const mixedEmail = `${site.key}-mixed@example.invalid`;

    await grantPhiCliSiteAdmin(pool, { siteId: site.id, email: soleEmail, passwordHash: "h" });
    const sole = await revokePhiCliSiteAdmin(pool, { siteId: site.id, email: soleEmail });
    expect(sole?.wasAdmin).toBe(true);
    const soleRows = await pool.query(
      `SELECT 1 FROM phis.user_site_role_claims c
       JOIN phis.user_emails e ON e.user_id = c.user_id
       WHERE e.email_normalized = $1 AND c.site_id = $2`,
      [soleEmail, site.id],
    );
    expect(soleRows.rowCount).toBe(0);

    await grantPhiCliSiteAdmin(pool, { siteId: site.id, email: mixedEmail, passwordHash: "h" });
    const { rows: mixedUser } = await pool.query<{ user_id: number }>(
      `SELECT user_id FROM phis.user_emails WHERE email_normalized = $1`,
      [mixedEmail],
    );
    await pool.query(
      `UPDATE phis.user_site_role_claims
       SET role_flags = role_flags | $4
       WHERE user_id = $1 AND site_id = $2 AND provider_id = $3`,
      [mixedUser[0]!.user_id, site.id, PHI_CORE_ROLE_PROVIDER_ID, PhiBaseRole.Publisher],
    );
    await revokePhiCliSiteAdmin(pool, { siteId: site.id, email: mixedEmail });
    const { rows: left } = await pool.query<{ role_flags: number }>(
      `SELECT role_flags FROM phis.user_site_role_claims
       WHERE user_id = $1 AND site_id = $2 AND provider_id = $3`,
      [mixedUser[0]!.user_id, site.id, PHI_CORE_ROLE_PROVIDER_ID],
    );
    expect(left[0]!.role_flags).toBe(PhiBaseRole.Publisher);
  });

  it("says nothing happened when the role was not held", async () => {
    const pool = await requirePhiTestDatabase();
    const email = `${site.key}-never@example.invalid`;
    await grantPhiCliSiteAdmin(pool, { siteId: site.id, email, passwordHash: "h" });
    await revokePhiCliSiteAdmin(pool, { siteId: site.id, email });

    const again = await revokePhiCliSiteAdmin(pool, { siteId: site.id, email });
    expect(again).toEqual({ userId: expect.any(Number), wasAdmin: false });
    expect(await revokePhiCliSiteAdmin(pool, { siteId: site.id, email: "nobody@example.invalid" }))
      .toBeNull();
  });
});

/**
 * A password belongs to the account, not to the Site the operator named.
 *
 * `user_password_credentials` is keyed by user alone, so one command replaces the credential for every
 * Site that account is a member of. The refusal without `--overwrite` is what stands between an operator
 * who means to set a password and one who means to replace somebody's.
 */
describe("setting a password from the CLI", () => {
  it("refuses to replace an existing password without being told to", async () => {
    const pool = await requirePhiTestDatabase();
    const email = `${site.key}-pw@example.invalid`;
    await grantPhiCliSiteAdmin(pool, { siteId: site.id, email, passwordHash: "original" });

    const refused = await setPhiCliUserPassword(pool, {
      siteId: site.id,
      email,
      passwordHash: "replacement",
      overwrite: false,
    });
    expect(refused).toMatchObject({ ok: false, reason: "password-exists" });

    const accepted = await setPhiCliUserPassword(pool, {
      siteId: site.id,
      email,
      passwordHash: "replacement",
      overwrite: true,
    });
    expect(accepted).toMatchObject({ ok: true, replaced: true });
  });

  it("names every Site the new credential opens", async () => {
    const pool = await requirePhiTestDatabase();
    const email = `${site.key}-both@example.invalid`;
    await grantPhiCliSiteAdmin(pool, { siteId: site.id, email, passwordHash: "h" });
    await grantPhiCliSiteAdmin(pool, { siteId: other.id, email, passwordHash: "h" });

    const result = await setPhiCliUserPassword(pool, {
      siteId: site.id,
      email,
      passwordHash: "new",
      overwrite: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.siteIds).toEqual(expect.arrayContaining([site.id, other.id]));
    }
  });

  it("refuses an account that is not a member of the named Site", async () => {
    const pool = await requirePhiTestDatabase();
    const email = `${site.key}-stranger@example.invalid`;
    await grantPhiCliSiteAdmin(pool, { siteId: site.id, email, passwordHash: "h" });

    expect(await setPhiCliUserPassword(pool, {
      siteId: other.id,
      email,
      passwordHash: "new",
      overwrite: true,
    })).toMatchObject({ ok: false, reason: "not-a-member" });
  });

  it("refuses an address nobody holds", async () => {
    const pool = await requirePhiTestDatabase();
    expect(await setPhiCliUserPassword(pool, {
      siteId: site.id,
      email: "nobody@example.invalid",
      passwordHash: "new",
      overwrite: true,
    })).toMatchObject({ ok: false, reason: "no-account" });
  });
});
