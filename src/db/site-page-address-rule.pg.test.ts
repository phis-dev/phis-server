import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestPageScope,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { validateCmsPageWriteInput } from "@/lib/cms/write-validation";
import {
  changeSitePagePath,
  publishSitePageRevision,
  saveSitePageDraftRevision,
  SitePageExistsError,
  SitePagePathChangeError,
} from "./site-pages";

/** The payload the Builder sends when it creates a blank Site Page. */
function blankPageInput(path: string) {
  const validated = validateCmsPageWriteInput({
    area: "public",
    path,
    sourcePreset: null,
    page: {
      status: 1,
      flags: 0,
      visibilityMask: 1,
      heroRootLayoutNodeId: null,
      headerBottomRootLayoutNodeId: null,
      siderRightRootLayoutNodeId: null,
      contentRootLayoutNodeId: null,
      footerTopRootLayoutNodeId: null,
      drawerRightRootLayoutNodeId: null,
      layoutConfig: { pageRegionConfigs: {} },
    },
    overlays: [],
    layoutNodes: [],
    contentWidgets: [],
  });
  if (!validated.ok) throw new Error(`Invalid test page input: ${validated.error}`);
  return validated.value;
}

async function refusal(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    if (error instanceof SitePagePathChangeError || error instanceof SitePageExistsError) return error;
    throw error;
  }
  throw new Error("The write was expected to be refused.");
}

async function scopeRow(scopeId: number) {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ path: string; draft_path: string | null; working_draft_revision_id: number | null }>(
    `SELECT path, draft_path, working_draft_revision_id FROM phis.site_page_scopes WHERE id = $1`,
    [scopeId],
  );
  return rows[0];
}

/**
 * A Page is never a folder: no Site Page lies beneath another, in either direction, whether the other
 * address is live, pending or held by a tombstoned Scope. The rule is checked under one lock per Area by
 * every writer that creates, moves or promotes an address.
 */
describe("Site Page addresses against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("address-rule");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  describe("moving a Page", () => {
    it("refuses a path beneath another Page", async () => {
      await createPhiTestPageScope(site, "/pgtest-docs");
      const mover = await createPhiTestPageScope(site, "/pgtest-docs-mover");

      const error = await refusal(changeSitePagePath(site.id, 1, mover, "/pgtest-docs/guide"));

      expect(error).toMatchObject({ code: "path_nested" });
      expect((await scopeRow(mover))?.draft_path).toBeNull();
    });

    it("refuses a path that would hold another Page beneath it", async () => {
      await createPhiTestPageScope(site, "/pgtest-shop/cart");
      const mover = await createPhiTestPageScope(site, "/pgtest-shop-mover");

      expect(await refusal(changeSitePagePath(site.id, 1, mover, "/pgtest-shop"))).toMatchObject({ code: "path_nested" });
    });

    it("counts another Page's pending path, and a tombstoned Page's path, the way it counts a live one", async () => {
      const pending = await createPhiTestPageScope(site, "/pgtest-pending-owner");
      await changeSitePagePath(site.id, 1, pending, "/pgtest-news/today");
      const tombstoned = await createPhiTestPageScope(site, "/pgtest-archive");
      const pool = await requirePhiTestDatabase();
      await pool.query(`UPDATE phis.site_page_scopes SET tombstoned_at = NOW() WHERE id = $1`, [tombstoned]);
      const mover = await createPhiTestPageScope(site, "/pgtest-reserved-mover");

      expect(await refusal(changeSitePagePath(site.id, 1, mover, "/pgtest-news"))).toMatchObject({ code: "path_nested" });
      expect(await refusal(changeSitePagePath(site.id, 1, mover, "/pgtest-archive/2025"))).toMatchObject({ code: "path_nested" });
    });

    it("treats a shared prefix that is not a whole segment as no relation at all", async () => {
      await createPhiTestPageScope(site, "/pgtest-doc");
      const mover = await createPhiTestPageScope(site, "/pgtest-segment-mover");

      const result = await changeSitePagePath(site.id, 1, mover, "/pgtest-doctor");

      expect(result.pendingPath).toBe("/pgtest-doctor");
    });

    it("does not treat the Area root as a folder", async () => {
      const pool = await requirePhiTestDatabase();
      const { rows } = await pool.query<{ id: number }>(
        `SELECT id FROM phis.site_page_scopes WHERE site_id = $1 AND area_id = 1 AND path = '/'`,
        [site.id],
      );
      if (!rows[0]) await createPhiTestPageScope(site, "/");
      const mover = await createPhiTestPageScope(site, "/pgtest-root-mover");

      const result = await changeSitePagePath(site.id, 1, mover, "/pgtest-under-root");

      expect(result.pendingPath).toBe("/pgtest-under-root");
    });
  });

  describe("creating a Page", () => {
    it("creates a Page on a free path", async () => {
      const draft = await saveSitePageDraftRevision(site.id, blankPageInput("/pgtest-create-free"), { createOnly: true });

      expect(draft.path).toBe("/pgtest-create-free");
      expect(draft.revisionId).toBeGreaterThan(0);
    });

    it("answers page_exists with the Page, and writes no draft over it, when the path is held", async () => {
      const held = await createPhiTestPageScope(site, "/pgtest-create-held");

      const error = await refusal(saveSitePageDraftRevision(site.id, blankPageInput("/pgtest-create-held"), { createOnly: true }));

      expect(error).toBeInstanceOf(SitePageExistsError);
      expect(error).toMatchObject({ pageScopeId: held, path: "/pgtest-create-held", tombstoned: false });
      expect((await scopeRow(held))?.working_draft_revision_id).toBeNull();
    });

    it("refuses to create a Page beneath another Page", async () => {
      await saveSitePageDraftRevision(site.id, blankPageInput("/pgtest-create-parent"), { createOnly: true });

      const error = await refusal(
        saveSitePageDraftRevision(site.id, blankPageInput("/pgtest-create-parent/child"), { createOnly: true }),
      );

      expect(error).toMatchObject({ code: "path_nested" });
    });

    it("keeps a plain save on a held path attaching to that Page, as it always did", async () => {
      const held = await createPhiTestPageScope(site, "/pgtest-save-attach");

      const draft = await saveSitePageDraftRevision(site.id, blankPageInput("/pgtest-save-attach"));

      const pool = await requirePhiTestDatabase();
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*) FROM phis.site_page_scopes WHERE site_id = $1 AND path = '/pgtest-save-attach'`,
        [site.id],
      );
      expect(rows[0]?.count).toBe("1");
      expect((await scopeRow(held))?.working_draft_revision_id).toBe(draft.revisionId);
    });
  });

  describe("publishing a move", () => {
    it("refuses to promote a pending path a Page has settled beneath since it was proposed", async () => {
      const created = await saveSitePageDraftRevision(site.id, blankPageInput("/pgtest-publish-from"), { createOnly: true });
      const pool = await requirePhiTestDatabase();
      const { rows } = await pool.query<{ id: number }>(
        `SELECT id FROM phis.site_page_scopes WHERE site_id = $1 AND path = '/pgtest-publish-from'`,
        [site.id],
      );
      const scopeId = rows[0]!.id;
      await changeSitePagePath(site.id, 1, scopeId, "/pgtest-publish-to");
      // Written past the rule on purpose: data that predates it, which a publish must still not promote.
      await createPhiTestPageScope(site, "/pgtest-publish-to/child");

      const error = await refusal(publishSitePageRevision(site.id, {
        areaMask: 1,
        address: { kind: "path", path: "/pgtest-publish-from" },
        revisionId: created.revisionId,
      }));

      expect(error).toMatchObject({ code: "path_nested" });
      expect(await scopeRow(scopeId)).toMatchObject({ path: "/pgtest-publish-from", draft_path: "/pgtest-publish-to" });
    });
  });
});
