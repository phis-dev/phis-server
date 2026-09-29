import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PHI_MAINTENANCE_TASKS, runPhiMaintenance } from "../cli/maintain.mts";
import { ensureAddonMediaSpace, ensureSiteMediaSpace } from "@/db/media-spaces";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * The one place cleanup that nobody is waiting for lives.
 *
 * The other kind belongs to the request that needs its result, and stays there. What is here repairs a
 * figure or removes something nothing points at -- which is why every task has to be safe to run twice,
 * safe to run from two instances at once, and honest under `--dry-run`.
 *
 * These are the properties a task added later has to keep, so they are tested against the registry
 * rather than against any one task.
 */

const ADDON = "@pgtest/maintain";

describe("maintenance", () => {
  let site: PhiTestSite;
  let actor: number;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("maintain");
    actor = await createPhiTestUser(site);
    await pool.query(
      `INSERT INTO phis.server_addons
         (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
       VALUES ($1, $1, '0.1.0', '1', repeat('0', 64), 'pgtest')
       ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON],
    );
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await closePhiTestPool();
  });

  /** A reservation that ran out, which is what the request path leaves when nobody comes back. */
  async function expiredSession(spaceId: number, profileId: number, bytes: number) {
    const pool = await requirePhiTestDatabase();
    const token = `pgtest-${crypto.randomUUID()}`;
    await pool.query(
      `INSERT INTO phis.media_upload_sessions
         (token, site_id, actor_user_id, space_id, storage_profile_id, status, filename,
          content_type, size_bytes, kind, staging_storage_key, expires_at)
       VALUES ($1, $2, $3, $4, $5, 0, 'x.bin', 'application/octet-stream', $6, 'file', $7, NOW() - interval '1 hour')`,
      [token, site.id, actor, spaceId, profileId, bytes, `staging/${token}`],
    );
    await pool.query(
      `UPDATE phis.media_spaces SET reserved_bytes = reserved_bytes + $2 WHERE id = $1`,
      [spaceId, bytes],
    );
    return token;
  }

  it("names every task it can run", () => {
    const ids = PHI_MAINTENANCE_TASKS.map((task) => task.id);
    expect(ids).toContain("upload-sessions");
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of PHI_MAINTENANCE_TASKS) {
      expect(task.summary.length).toBeGreaterThan(0);
    }
  });

  it("changes nothing under a dry run", async () => {
    const pool = await requirePhiTestDatabase();
    const { space } = await ensureSiteMediaSpace(site.id);
    const token = await expiredSession(space.id, space.defaultStorageProfileId, 500);

    const reports = await runPhiMaintenance(pool, { only: "upload-sessions", dryRun: true });
    expect(reports[0]!.error).toBeNull();
    expect(reports[0]!.cleared).toBeGreaterThanOrEqual(1);

    // Still there, which is the whole promise of the flag.
    const { rows } = await pool.query(
      `SELECT token FROM phis.media_upload_sessions WHERE token = $1`, [token],
    );
    expect(rows).toHaveLength(1);
  });

  it("releases what ran out, and gives the Space its figure back", async () => {
    const pool = await requirePhiTestDatabase();
    const { space } = await ensureSiteMediaSpace(site.id);
    const before = await pool.query<{ reserved_bytes: string }>(
      `SELECT reserved_bytes FROM phis.media_spaces WHERE id = $1`, [space.id],
    );

    const reports = await runPhiMaintenance(pool, { only: "upload-sessions" });
    expect(reports[0]!.error).toBeNull();

    const after = await pool.query<{ reserved_bytes: string }>(
      `SELECT reserved_bytes FROM phis.media_spaces WHERE id = $1`, [space.id],
    );
    // The 500 from the dry-run test above, which was left standing on purpose.
    expect(Number(after.rows[0]!.reserved_bytes))
      .toBe(Number(before.rows[0]!.reserved_bytes) - 500);
    expect((await pool.query(
      `SELECT token FROM phis.media_upload_sessions WHERE space_id = $1 AND expires_at < NOW()`,
      [space.id],
    )).rows).toHaveLength(0);
  });

  it("reaches a Space nobody has uploaded into since, which the request path cannot", async () => {
    /*
     * This is the whole reason the command exists. The request path releases the Space it is reserving
     * against, so a Space with one abandoned upload and no traffic afterwards keeps a figure that is
     * wrong -- harmlessly, because the reader discounts an expired reservation, but wrong.
     */
    const pool = await requirePhiTestDatabase();
    const space = await ensureAddonMediaSpace(site.id, ADDON);
    await expiredSession(space.id, space.defaultStorageProfileId, 900);

    await runPhiMaintenance(pool, { only: "upload-sessions" });
    const { rows } = await pool.query<{ reserved_bytes: string }>(
      `SELECT reserved_bytes FROM phis.media_spaces WHERE id = $1`, [space.id],
    );
    expect(Number(rows[0]!.reserved_bytes)).toBe(0);
  });

  it("is the same to run twice, because an operator will", async () => {
    const pool = await requirePhiTestDatabase();
    const first = await runPhiMaintenance(pool);
    const second = await runPhiMaintenance(pool);
    expect(first.every((report) => report.error === null)).toBe(true);
    // Nothing was left for the second pass, and it is not an error that there was nothing.
    expect(second.every((report) => report.error === null && report.cleared === 0)).toBe(true);
  });

  it("sets an Add-on store's counters to what the store holds", async () => {
    const pool = await requirePhiTestDatabase();
    await ensureSiteMediaSpace(site.id);
    // Two writes of one new key at once both booked an object; one landed.
    await pool.query(
      `INSERT INTO phis.site_server_addons (site_id, addon_id, storage_used_bytes, storage_used_objects)
       VALUES ($1, $2, 20, 2)
       ON CONFLICT (site_id, addon_id)
       DO UPDATE SET storage_used_bytes = 20, storage_used_objects = 2`,
      [site.id, ADDON],
    );
    const openStore = async () => ({
      listPrefix: async (prefix: string) => [{ storageKey: `${prefix}/report.pdf`, byteSize: 10 }],
    });

    const dry = await runPhiMaintenance(pool, { only: "addon-storage", dryRun: true, openStore });
    expect(dry[0]!.error).toBeNull();
    const reports = await runPhiMaintenance(pool, { only: "addon-storage", openStore });
    expect(reports[0]!.error).toBeNull();
    expect(reports[0]!.cleared).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query<{ storage_used_bytes: string; storage_used_objects: number }>(
      `SELECT storage_used_bytes, storage_used_objects FROM phis.site_server_addons
        WHERE site_id = $1 AND addon_id = $2`,
      [site.id, ADDON],
    );
    expect(rows[0]).toEqual({ storage_used_bytes: "10", storage_used_objects: 1 });
  });

  it("refuses a task it does not have rather than doing nothing quietly", async () => {
    const pool = await requirePhiTestDatabase();
    await expect(runPhiMaintenance(pool, { only: "tidy-everything" }))
      .rejects.toThrow(/is not a maintenance task/);
  });

  it("reports a task that fails and keeps going", async () => {
    /*
     * An operator running this wants the state of everything. Stopping at the first unreachable thing
     * would hide the rest behind it, and the rest is what they would have acted on.
     */
    const reports = await runPhiMaintenance(
      { query: () => Promise.reject(new Error("the database went away")) } as never,
    );
    expect(reports).toHaveLength(PHI_MAINTENANCE_TASKS.length);
    expect(reports.every((report) => report.error === "the database went away")).toBe(true);
  });
});
