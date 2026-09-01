import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * Where a probe's answer is kept, and why it is kept rather than recomputed.
 *
 * It is an observation with a date on it, not configuration. An operator did not decide that this
 * endpoint verifies checksums -- it was found out by trying, and the finding has to survive the process
 * that made it, because what depends on it later is which upload plan a Profile is allowed to issue.
 *
 * It lives beside `config` rather than inside it for the same reason: `config` is what the operator
 * wrote and the Provider validated, and mixing a measurement into it would make the two indistinguishable
 * the next time somebody edits one.
 */

describe("a Storage Profile's recorded probe", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("storage-probe");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function createProfile(key: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_storage_profiles (site_id, key, provider_id, config)
       VALUES ($1, $2, '@phis/server/storage-local', '{}'::jsonb) RETURNING id`,
      [site.id, key],
    );
    return rows[0]!.id;
  }

  it("is absent until something has actually been tried", async () => {
    const pool = await requirePhiTestDatabase();
    const id = await createProfile("untested");
    const { rows } = await pool.query<{ probe: unknown; probed_at: Date | null }>(
      `SELECT probe, probed_at FROM phis.media_storage_profiles WHERE id = $1`,
      [id],
    );
    // Null and "false" are different answers: nobody asked, versus asked and told no.
    expect(rows[0]!.probe).toBeNull();
    expect(rows[0]!.probed_at).toBeNull();
  });

  it("keeps the answer and the moment it was true", async () => {
    const pool = await requirePhiTestDatabase();
    const id = await createProfile("probed");
    await pool.query(
      `UPDATE phis.media_storage_profiles SET probe = $2::jsonb, probed_at = NOW() WHERE id = $1`,
      [id, JSON.stringify({ writable: true, verifiesSha256: true, findings: [] })],
    );

    const { rows } = await pool.query<{
      probe: { writable: boolean; verifiesSha256: boolean; findings: string[] };
      probed_at: Date;
    }>(
      `SELECT probe, probed_at FROM phis.media_storage_profiles WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.probe.verifiesSha256).toBe(true);
    expect(rows[0]!.probed_at).toBeInstanceOf(Date);
  });

  it("carries the findings, because a no is only useful with its reason", async () => {
    const pool = await requirePhiTestDatabase();
    const id = await createProfile("refused");
    await pool.query(
      `UPDATE phis.media_storage_profiles SET probe = $2::jsonb, probed_at = NOW() WHERE id = $1`,
      [id, JSON.stringify({
        writable: true,
        verifiesSha256: false,
        findings: ["This endpoint accepted an object whose declared SHA-256 does not match its bytes."],
      })],
    );

    const { rows } = await pool.query<{ probe: { findings: string[] } }>(
      `SELECT probe FROM phis.media_storage_profiles WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.probe.findings).toHaveLength(1);
  });

  it("goes with the Site, like everything else hanging off it", async () => {
    const pool = await requirePhiTestDatabase();
    await createProfile("cascading");
    await dropPhiTestSites();
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM phis.media_storage_profiles WHERE site_id = $1`,
      [site.id],
    );
    expect(rows[0]!.count).toBe("0");
    site = await createPhiTestSite("storage-probe-again");
  });
});
