import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { PhiCmsStatus } from "@phis/contracts/cms";
import { validateCmsPageWriteInput } from "@/lib/cms/write-validation";
import { SiteCmsDraftConflictError } from "./site-revision-scopes";
import { publishSitePageRevision, saveSitePageDraftRevision } from "./site-pages";

/**
 * A publish clears the Working Draft it publishes from. Naming another revision of the scope used to go
 * through: the older revision went live and the Draft somebody was working on was dropped unsaid.
 */
function pageInput(path: string) {
  const validated = validateCmsPageWriteInput({
    area: "public",
    path,
    sourcePreset: null,
    page: {
      status: PhiCmsStatus.Published,
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
    controllerSettings: [],
  });
  if (!validated.ok) throw new Error(`Invalid test page input: ${validated.error}`);
  return validated.value;
}

describe("publishing a Site Page against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("publish-draft");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function pointersOf(path: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{
      published_revision_id: number | null;
      working_draft_revision_id: number | null;
    }>(
      `SELECT published_revision_id, working_draft_revision_id
       FROM phis.site_page_scopes WHERE site_id = $1 AND area_id = 1 AND path = $2`,
      [site.id, path],
    );
    return rows[0]!;
  }

  it("publishes the Working Draft and refuses any other revision of the scope", async () => {
    const path = `/pgtest-publish-${Math.random().toString(36).slice(2)}`;
    const address = { kind: "path" as const, path };
    const first = await saveSitePageDraftRevision(site.id, pageInput(path), { createOnly: true });
    await publishSitePageRevision(site.id, { areaMask: 1, address, revisionId: first.revisionId });
    const draft = await saveSitePageDraftRevision(site.id, pageInput(path));

    await expect(
      publishSitePageRevision(site.id, { areaMask: 1, address, revisionId: first.revisionId }),
    ).rejects.toBeInstanceOf(SiteCmsDraftConflictError);
    expect(await pointersOf(path)).toEqual({
      published_revision_id: first.revisionId,
      working_draft_revision_id: draft.revisionId,
    });

    await publishSitePageRevision(site.id, { areaMask: 1, address, revisionId: draft.revisionId });
    expect(await pointersOf(path)).toEqual({
      published_revision_id: draft.revisionId,
      working_draft_revision_id: null,
    });
  });
});
