import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ensurePhiMediaStorageProfileProbe,
  phiMediaStorageProfileVerifiesSha256,
} from "@/lib/media-storage-profile-probe";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * Probing on first use, which is the case the operator's commands cannot cover.
 *
 * `phis storage probe` and the Profile commands measure an endpoint at the moments an operator is
 * present. A Profile can reach an upload without having passed through either -- restored from a dump,
 * written by a migration, configured before the probe existed -- and the decision that reads the result
 * has no safe default: a digest nobody verified must not be recorded as a checked one, and a Provider
 * that does verify must not be forced through Core for want of an answer.
 */

describe("probing a Storage Profile on first use", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("profile-probe");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function createProfile(key: string, providerId: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_storage_profiles (site_id, key, provider_id, config)
       VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id`,
      [site.id, key, providerId],
    );
    return { id: rows[0]!.id, siteId: site.id, providerId, config: {}, secretReference: null };
  }

  const readRow = async (id: number) => {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ probe: { verifiesSha256?: boolean; findings?: string[] } | null; probed_at: Date | null }>(
      `SELECT probe, probed_at FROM phis.media_storage_profiles WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  };

  it("does not probe Core's own storage, and does not claim it verifies anything", async () => {
    const profile = await createProfile("local", "@phis/server/storage-local");

    const probe = await ensurePhiMediaStorageProfileProbe(profile, site.key);

    expect(probe?.verifiesSha256).toBe(false);
    // Nothing is delivered to it by a client, so there is nothing to measure and nothing is written.
    expect((await readRow(profile.id)).probed_at).toBeNull();
  });

  it("records an unreachable Provider as an answer rather than throwing", async () => {
    const profile = await createProfile("unreachable", "@phis/nobody/storage-nowhere");

    const probe = await ensurePhiMediaStorageProfileProbe(profile, site.key);

    expect(probe?.writable).toBe(false);
    expect(probe?.verifiesSha256).toBe(false);
    expect(probe?.findings.join(" ")).toMatch(/could not be reached/i);

    const row = await readRow(profile.id);
    expect(row.probed_at).not.toBeNull();
    // The reason survives, because a no is only useful with one.
    expect(row.probe?.findings?.length).toBeGreaterThan(0);
  });

  it("does not dial an endpoint that already answered, however it answered", async () => {
    const profile = await createProfile("answered-once", "@phis/nobody/storage-nowhere");

    await ensurePhiMediaStorageProfileProbe(profile, site.key);
    const first = await readRow(profile.id);
    await ensurePhiMediaStorageProfileProbe(profile, site.key);
    const second = await readRow(profile.id);

    // An endpoint that is down would otherwise be dialled again on every upload into it, and every
    // upload would wait out the same timeout.
    expect(second.probed_at?.toISOString()).toBe(first.probed_at?.toISOString());
  });

  it("reads an already recorded verification instead of measuring again", async () => {
    const pool = await requirePhiTestDatabase();
    const profile = await createProfile("recorded", "@phis/nobody/storage-nowhere");
    await pool.query(
      `UPDATE phis.media_storage_profiles
          SET probe = $2::jsonb, probed_at = NOW() WHERE id = $1`,
      [profile.id, JSON.stringify({ writable: true, verifiesSha256: true, findings: [] })],
    );

    // The Provider does not exist, so an answer could only have come from the record.
    expect(await phiMediaStorageProfileVerifiesSha256(profile, site.key)).toBe(true);
  });

  it("says no for a Profile that is not there at all", async () => {
    const missing = {
      id: 987654321,
      siteId: site.id,
      providerId: "@phis/nobody/storage-nowhere",
      config: {},
      secretReference: null,
    };

    expect(await ensurePhiMediaStorageProfileProbe(missing, site.key)).toBeNull();
    expect(await phiMediaStorageProfileVerifiesSha256(missing, site.key)).toBe(false);
  });
});
