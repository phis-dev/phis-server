import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestPageScope,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { restoreSiteRevision } from "./site-revisions";

/**
 * A restore hands the editor a Working Draft, and the next save reads that Draft's metadata. What the
 * restore writes into the row is what decides whether that save succeeds, so it is read back here.
 */
describe("restoring a revision against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("restore");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function revision(scopeId: number, draft: { version: number; nextNodeSequence: number } | null) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.site_page_revisions (page_scope_id, meta_json)
       VALUES ($1, $2::jsonb) RETURNING id`,
      [scopeId, JSON.stringify(draft ? { draft, note: "kept" } : {})],
    );
    return rows[0]!.id;
  }

  it("gives the restored Draft metadata above everything the scope has used", async () => {
    const path = `/pgtest-restore-${Math.random().toString(36).slice(2)}`;
    const scopeId = await createPhiTestPageScope(site, path);
    const old = await revision(scopeId, { version: 2, nextNodeSequence: 5 });
    const published = await revision(scopeId, { version: 7, nextNodeSequence: 40 });
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `UPDATE phis.site_page_scopes SET published_revision_id = $2 WHERE id = $1`,
      [scopeId, published],
    );

    const restored = await restoreSiteRevision(site.id, {
      kind: "page",
      areaMask: 1,
      address: { kind: "path", path },
      revisionId: old,
    });

    const { rows } = await pool.query<{ meta_json: Record<string, unknown> }>(
      `SELECT meta_json FROM phis.site_page_revisions WHERE id = $1`,
      [restored.revisionId],
    );
    // Above the published revision's version and sequence, not the restored one's: the sequence keeps
    // new nodes clear of every instance id the scope has handed out.
    expect(rows[0]!.meta_json).toEqual({ note: "kept", draft: { version: 8, nextNodeSequence: 40 } });
  });

  it("starts a Draft of a scope that never recorded any at version one", async () => {
    const path = `/pgtest-restore-${Math.random().toString(36).slice(2)}`;
    const scopeId = await createPhiTestPageScope(site, path);
    const bare = await revision(scopeId, null);

    const restored = await restoreSiteRevision(site.id, {
      kind: "page",
      areaMask: 1,
      address: { kind: "path", path },
      revisionId: bare,
    });

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ meta_json: Record<string, unknown> }>(
      `SELECT meta_json FROM phis.site_page_revisions WHERE id = $1`,
      [restored.revisionId],
    );
    expect(rows[0]!.meta_json).toEqual({ draft: { version: 1, nextNodeSequence: 1 } });
  });
});
