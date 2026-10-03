import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestPageScope,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

import { readSitePageScopeTargets } from "./site-pages";

afterAll(async () => {
  await closePhiTestPool();
});

/**
 * A page reference resolves through the scopes it names, not the Area's whole catalogue. What a fake
 * cannot show is that the Area still bounds the answer: the same id in another Area is not there.
 */
describe("readSitePageScopeTargets against PostgreSQL", () => {
  let site: PhiTestSite;
  let live: number;
  let gone: number;
  let elsewhere: number;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("scope-targets");
    live = await createPhiTestPageScope(site, "/kontakt");
    gone = await createPhiTestPageScope(site, "/alt");
    elsewhere = await createPhiTestPageScope(site, "/konto", 2);
    await pool.query(`UPDATE phis.site_page_scopes SET tombstoned_at = NOW() WHERE id = $1`, [gone]);
  });

  afterAll(async () => {
    await dropPhiTestSites();
  });

  it("answers the named scopes of the Area and nothing else", async () => {
    const targets = await readSitePageScopeTargets(site.id, 1, [live, gone, elsewhere, 999_999_999]);

    expect(targets.get(live)).toEqual({ path: "/kontakt", tombstoned: false });
    expect(targets.get(gone)).toEqual({ path: "/alt", tombstoned: true });
    expect(targets.has(elsewhere)).toBe(false);
    expect(targets.size).toBe(2);
  });
});
