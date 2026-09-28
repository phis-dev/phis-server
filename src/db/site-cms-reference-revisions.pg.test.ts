import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestAsset,
  createPhiTestPageScope,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  withPhiTestClient,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  listSiteCmsReferencesToAsset,
  PhiCmsReferenceSourceKind,
  pruneSiteCmsReferencesToLiveRevisionsWithDb,
  replaceSiteCmsReferencesWithDb,
} from "./site-cms-references";

/**
 * A Page has more than one live revision -- the published one and its working draft -- and the
 * readers count references of both. Which rows a draft save leaves standing, and which fall once no
 * pointer names their revision, is decided by statements against the scope's pointers.
 */
describe("CMS references per revision against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("reference-revisions");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function revision(scopeId: number) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.site_page_revisions (page_scope_id) VALUES ($1) RETURNING id`,
      [scopeId],
    );
    return rows[0]!.id;
  }

  async function point(scopeId: number, published: number | null, draft: number | null) {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `UPDATE phis.site_page_scopes SET published_revision_id = $2, working_draft_revision_id = $3
       WHERE id = $1`,
      [scopeId, published, draft],
    );
  }

  function index(scopeId: number, revisionId: number, assetId: number) {
    return withPhiTestClient((client) => replaceSiteCmsReferencesWithDb(client, {
      siteId: site.id,
      sourceKind: PhiCmsReferenceSourceKind.Page,
      sourceScopeId: scopeId,
      sourceRevisionId: revisionId,
      references: [{ location: "/widgets/0/config/src", reference: { kind: "asset", assetId } }],
    }));
  }

  it("keeps the published revision's references while the draft is saved", async () => {
    const scopeId = await createPhiTestPageScope(site, `/pgtest-${Math.random()}`);
    const live = await createPhiTestAsset(site, `pgtest/live-${Math.random()}`);
    const drafted = await createPhiTestAsset(site, `pgtest/draft-${Math.random()}`);
    const published = await revision(scopeId);
    const draft = await revision(scopeId);
    await point(scopeId, published, null);
    await index(scopeId, published, live);

    await index(scopeId, draft, drafted);
    await point(scopeId, published, draft);
    // Saved again, as an editor does: still only the draft's own rows are replaced.
    await index(scopeId, draft, drafted);

    expect(await listSiteCmsReferencesToAsset(site.id, live)).toHaveLength(1);
    expect(await listSiteCmsReferencesToAsset(site.id, drafted)).toHaveLength(1);
  });

  it("lets a revision's rows go once no pointer names it, releasing what they held", async () => {
    const scopeId = await createPhiTestPageScope(site, `/pgtest-${Math.random()}`);
    const old = await createPhiTestAsset(site, `pgtest/old-${Math.random()}`);
    const published = await revision(scopeId);
    const draft = await revision(scopeId);
    await point(scopeId, published, draft);
    await index(scopeId, published, old);

    // The draft is published; the old published revision is history now.
    await point(scopeId, draft, null);
    await withPhiTestClient((client) => pruneSiteCmsReferencesToLiveRevisionsWithDb(client, {
      sourceKind: PhiCmsReferenceSourceKind.Page,
      sourceScopeId: scopeId,
    }));

    const pool = await requirePhiTestDatabase();
    const { rowCount } = await pool.query(
      `SELECT 1 FROM phis.site_cms_references WHERE source_kind = 1 AND source_scope_id = $1`,
      [scopeId],
    );
    expect(rowCount).toBe(0);
    // Nothing holds the Asset under RESTRICT any more.
    const removal = pool.query(`DELETE FROM phis.media_assets WHERE id = $1`, [old]);
    await expect(removal).resolves.toBeDefined();
  });
});
