import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * The read marker through the Site config read a Site makes, against the development database. What a
 * Site keeps between reads is published data, so a publish in any form moves the marker and a draft does
 * not: otherwise every Site process would empty its caches each time the Builder saves as an author types.
 */

vi.mock("@/lib/api-v1-guard", () => ({
  guardApiV1: () => null,
  getApiV1TokenMode: () => "internal",
}));

import {
  closePhiTestPool,
  createPhiTestPageScope,
  createPhiTestSite,
  createPhiTestThemeScope,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../../../../test/pg/harness";
import { SITE_FLAG_ACTIVE } from "@/lib/site-flags";
import { GET } from "./route";

describe("the Site read marker on /api/v1/site", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;

  async function marker(of: PhiTestSite = site): Promise<string> {
    const response = await GET(new Request("http://phis.test/api/v1/site", {
      headers: { "x-phis-site-key": of.key },
    }));
    expect(response.status).toBe(200);
    return (await response.json()).site.readMarker;
  }

  async function query(sql: string, params: unknown[]) {
    const pool = await requirePhiTestDatabase();
    await pool.query(sql, params);
  }

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("read-marker");
    other = await createPhiTestSite("read-marker-other");
    // The endpoint resolves only an active Site; the harness creates them inactive.
    await query("UPDATE phis.sites SET flags = flags | $2 WHERE id = ANY($1)", [[site.id, other.id], SITE_FLAG_ACTIVE]);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("moves when the Site's own settings change, and only for that Site", async () => {
    const before = await marker();
    const otherBefore = await marker(other);

    await query("UPDATE phis.sites SET name = $2 WHERE id = $1", [site.id, "Renamed"]);

    expect(await marker()).not.toBe(before);
    expect(await marker(other)).toBe(otherBefore);
  });

  it("moves when a Page is published, not when its draft is saved", async () => {
    const scopeId = await createPhiTestPageScope(site, "/marker-probe");
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.site_page_revisions (page_scope_id) VALUES ($1), ($1) RETURNING id`,
      [scopeId],
    );
    const [draftId, publishedId] = rows.map((row) => row.id);

    const beforeDraft = await marker();
    await query("UPDATE phis.site_page_scopes SET working_draft_revision_id = $2 WHERE id = $1", [scopeId, draftId]);
    expect(await marker()).toBe(beforeDraft);

    await query("UPDATE phis.site_page_scopes SET published_revision_id = $2 WHERE id = $1", [scopeId, publishedId]);
    const afterPublish = await marker();
    expect(afterPublish).not.toBe(beforeDraft);

    await query("UPDATE phis.site_page_scopes SET tombstoned_at = NOW() WHERE id = $1", [scopeId]);
    expect(await marker()).not.toBe(afterPublish);
  });

  it("moves when a Theme scope comes or goes, not when only its label changes", async () => {
    const before = await marker();
    const scopeId = await createPhiTestThemeScope(site, "marker-probe");
    const afterInsert = await marker();
    expect(afterInsert).not.toBe(before);

    await query("UPDATE phis.site_theme_scopes SET label = 'Only a label' WHERE id = $1", [scopeId]);
    expect(await marker()).toBe(afterInsert);

    await query("DELETE FROM phis.site_theme_scopes WHERE id = $1", [scopeId]);
    expect(await marker()).not.toBe(afterInsert);
  });
});
