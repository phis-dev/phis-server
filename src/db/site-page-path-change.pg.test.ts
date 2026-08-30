import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestPageScope,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  withPhiTestClient,
  type PhiTestSite,
} from "../../test/pg/harness";
import { changeSitePagePath } from "./site-pages";

/**
 * What PostgreSQL does with the statements the unit suite pins: the transaction rolls back on a
 * throw, a second writer waits for the row rather than reading around it, and the partial unique
 * index -- not the collision query -- is what ultimately makes a duplicate canonical path impossible.
 */
describe("changeSitePagePath against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("path-change");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("rewrites the path and preserves the revision pointers", async () => {
    const scopeId = await createPhiTestPageScope(site, "/pgtest-move-from");

    const result = await changeSitePagePath(site.id, 1, scopeId, "/pgtest-move-to");

    expect(result).toMatchObject({ oldPath: "/pgtest-move-from", path: "/pgtest-move-to" });
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ path: string }>(
      `SELECT path FROM phis.site_page_scopes WHERE id = $1`,
      [scopeId],
    );
    expect(rows[0]?.path).toBe("/pgtest-move-to");
  });

  it("leaves the path untouched when the transaction rolls back on a collision", async () => {
    const occupied = await createPhiTestPageScope(site, "/pgtest-occupied");
    const mover = await createPhiTestPageScope(site, "/pgtest-mover");

    await expect(changeSitePagePath(site.id, 1, mover, "/pgtest-occupied")).rejects.toThrow();

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number; path: string }>(
      `SELECT id, path FROM phis.site_page_scopes WHERE id = ANY($1) ORDER BY id`,
      [[occupied, mover]],
    );
    expect(rows.map((row) => row.path)).toEqual(["/pgtest-occupied", "/pgtest-mover"]);
  });

  // Note what this does and does not show. It proves the whole operation waits for a row another
  // transaction holds -- the `UPDATE` alone would achieve that. It does not isolate the `FOR UPDATE`
  // on the initial read; removing that flag leaves this test green. The read lock earns its place
  // against a concurrent writer, which the collision test below covers.
  it("waits for a Scope another transaction holds rather than writing past it", async () => {
    const scopeId = await createPhiTestPageScope(site, "/pgtest-locked");

    const observed = await withPhiTestClient(async (holder) => {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM phis.site_page_scopes WHERE id = $1 FOR UPDATE`, [scopeId]);

      let settled = false;
      const contender = changeSitePagePath(site.id, 1, scopeId, "/pgtest-locked-moved")
        .then((value) => {
          settled = true;
          return value;
        });

      // Give the contender a chance to reach the lock. It must still be waiting.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const blockedWhileHeld = !settled;

      await holder.query("COMMIT");
      const result = await contender;
      return { blockedWhileHeld, result };
    });

    expect(observed.blockedWhileHeld).toBe(true);
    expect(observed.result.path).toBe("/pgtest-locked-moved");
  });

  it("refuses a Module-owned Scope without writing anything", async () => {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.site_page_scopes (site_id, area_id, owner_module_id, preset_key)
       VALUES ($1, 1, '@phis/pgtest', 'pgtest-page') RETURNING id`,
      [site.id],
    );
    const scopeId = rows[0]!.id;

    await expect(changeSitePagePath(site.id, 1, scopeId, "/pgtest-module")).rejects.toThrow();

    const { rows: after } = await pool.query<{ path: string | null }>(
      `SELECT path FROM phis.site_page_scopes WHERE id = $1`,
      [scopeId],
    );
    expect(after[0]?.path).toBeNull();
  });

  it("lets exactly one of two concurrent moves onto the same path win", async () => {
    const first = await createPhiTestPageScope(site, "/pgtest-race-a");
    const second = await createPhiTestPageScope(site, "/pgtest-race-b");

    const settled = await Promise.allSettled([
      changeSitePagePath(site.id, 1, first, "/pgtest-contested"),
      changeSitePagePath(site.id, 1, second, "/pgtest-contested"),
    ]);

    // Which of the two diagnostics the loser gets depends on the interleaving -- the collision query
    // when it reads after the winner committed, the unique index when both read before either wrote.
    // The invariant is the same either way: one winner, and never two Pages on one path.
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM phis.site_page_scopes
       WHERE site_id = $1 AND area_id = 1 AND path = '/pgtest-contested'`,
      [site.id],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("reserves a canonical path even while the Scope holding it is tombstoned", async () => {
    const pool = await requirePhiTestDatabase();
    const scopeId = await createPhiTestPageScope(site, "/pgtest-reserved");
    await pool.query(`UPDATE phis.site_page_scopes SET tombstoned_at = NOW() WHERE id = $1`, [scopeId]);

    await expect(
      pool.query(
        `INSERT INTO phis.site_page_scopes (site_id, area_id, path) VALUES ($1, 1, '/pgtest-reserved')`,
        [site.id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
