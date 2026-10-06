import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestPageScope,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { SITE_REVISION_TABLES, updateSiteDraftRevisionWithDb } from "./site-revision-scopes";
import { listSiteRevisionHistory } from "./site-revisions";

/**
 * A Working Draft is one row its saves rewrite, so `created_at` keeps the first save. What the revision
 * list shows as the last save is the stamp the rewrite leaves in `meta_json.saved`.
 */
describe("stamping a rewritten Working Draft against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("saved-stamp");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("answers when and by whom the Draft was saved last, and nothing for a row never rewritten", async () => {
    const path = `/pgtest-saved-${Math.random().toString(36).slice(2)}`;
    const scopeId = await createPhiTestPageScope(site, path);
    const userId = await createPhiTestUser(site);
    const pool = await requirePhiTestDatabase();
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO phis.site_page_revisions (page_scope_id, meta_json)
       VALUES ($1, '{}'::jsonb), ($1, '{}'::jsonb) RETURNING id`,
      [scopeId],
    );
    const [untouched, draft] = inserted.rows.map((row) => row.id);

    await updateSiteDraftRevisionWithDb(pool, SITE_REVISION_TABLES.page, draft!, scopeId, {
      flags: 0,
      treeJson: {},
      metaJson: { messageKey: "page_saved" },
      savedByUserId: userId,
    });

    const history = await listSiteRevisionHistory(site.id, {
      kind: "page",
      areaMask: 1,
      address: { kind: "path", path },
    });
    const saved = history.rows.find((row) => row.revisionId === draft)!;
    expect(saved.meta.messageKey).toBe("page_saved");
    expect(Number.isNaN(Date.parse(saved.savedAt ?? ""))).toBe(false);
    expect(saved.savedByLabel).toEqual(expect.any(String));
    const never = history.rows.find((row) => row.revisionId === untouched)!;
    expect(never.savedAt).toBeNull();
    expect(never.savedByLabel).toBeNull();
  });
});
