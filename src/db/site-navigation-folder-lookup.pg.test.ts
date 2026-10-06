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
import { createPhiPresetCmsInstanceId } from "@/lib/cms/instance-id";
import { createPhiPageReference } from "@/lib/internal-references";
import { publishSitePageRevision, saveSitePageDraftRevision } from "./site-pages";
import {
  publishSiteNavigationRevision,
  resolvePublishedSiteNavigationFolderTarget,
  saveSiteNavigationDraftRevision,
} from "./site-navigation";

const container = (nodeKey: string) => createPhiPresetCmsInstanceId({
  domain: "navigation",
  ownerModuleId: "@phis/ui/modules/docs",
  presetKey: "docs-nav",
  nodeKey,
});

async function publishedPage(site: PhiTestSite, path: string) {
  const validated = validateCmsPageWriteInput({
    area: "public",
    path,
    sourcePreset: null,
    page: {
      status: 1, flags: 0, visibilityMask: 1,
      heroRootLayoutNodeId: null, headerBottomRootLayoutNodeId: null, siderRightRootLayoutNodeId: null,
      contentRootLayoutNodeId: null, footerTopRootLayoutNodeId: null, drawerRightRootLayoutNodeId: null,
      layoutConfig: { pageRegionConfigs: {} },
    },
    overlays: [], layoutNodes: [], contentWidgets: [], controllerSettings: [],
  });
  if (!validated.ok) throw new Error(validated.error);
  const draft = await saveSitePageDraftRevision(site.id, validated.value, { createOnly: true });
  await publishSitePageRevision(site.id, { areaMask: 1, address: { kind: "path", path }, revisionId: draft.revisionId });
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM phis.site_page_scopes WHERE site_id = $1 AND path = $2`,
    [site.id, path],
  );
  return createPhiPageReference({ kind: "site", pageScopeId: rows[0]!.id });
}

async function publishNavigation(site: PhiTestSite, key: string, folders: { node: string; folder: unknown }[]) {
  await saveSiteNavigationDraftRevision(site.id, {
    key,
    overlay: {
      navKey: key,
      itemOverrides: folders.map((entry) => ({ id: container(entry.node), folder: entry.folder })),
      customItems: [],
      tombstones: [],
    },
    nextNodeSequence: 1,
  });
  await publishSiteNavigationRevision(site.id, { key });
}

/**
 * Looking a folder address up on the live Site: the published Navigations decide, the latest publish
 * first, and the chain is followed to a Page that is still there.
 */
describe("Resolving a folder address against PostgreSQL", () => {
  let site: PhiTestSite;
  let guide: string;
  let api: string;

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("folder-lookup");
    guide = await publishedPage(site, "/pgtest-docs/guides/start");
    api = await publishedPage(site, "/pgtest-docs/api");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("follows a sub-folder target to the Page its own target names", async () => {
    await publishNavigation(site, "public:header", [
      { node: "docs", folder: { address: "/pgtest-docs", target: { kind: "folder", address: "/pgtest-docs/guides" } } },
      { node: "guides", folder: { address: "/pgtest-docs/guides", target: { kind: "page", reference: guide } } },
    ]);

    expect(await resolvePublishedSiteNavigationFolderTarget(site.id, "public", "/pgtest-docs")).toEqual({ reference: guide });
    expect(await resolvePublishedSiteNavigationFolderTarget(site.id, "public", "/pgtest-docs/guides")).toEqual({ reference: guide });
  });

  it("lets the latest published Navigation decide an address two of them disagree on", async () => {
    await publishNavigation(site, "public:quicklinks", [
      { node: "docs", folder: { address: "/pgtest-docs", target: { kind: "page", reference: api } } },
    ]);

    expect(await resolvePublishedSiteNavigationFolderTarget(site.id, "public", "/pgtest-docs")).toEqual({ reference: api });
  });

  it("answers nothing for an address without a target, an unknown address, the root or another Area", async () => {
    await publishNavigation(site, "public:footer", [
      { node: "empty", folder: { address: "/pgtest-empty", target: null } },
    ]);

    expect(await resolvePublishedSiteNavigationFolderTarget(site.id, "public", "/pgtest-empty")).toBeNull();
    expect(await resolvePublishedSiteNavigationFolderTarget(site.id, "public", "/pgtest-nowhere")).toBeNull();
    expect(await resolvePublishedSiteNavigationFolderTarget(site.id, "public", "/")).toBeNull();
    expect(await resolvePublishedSiteNavigationFolderTarget(site.id, "admin", "/pgtest-docs")).toBeNull();
  });

  it("answers nothing for a Site Page that is tombstoned or was never published", async () => {
    const unpublished = createPhiPageReference({
      kind: "site",
      pageScopeId: await createPhiTestPageScope(site, "/pgtest-draft-only/page"),
    });
    await publishNavigation(site, "public:sider", [
      { node: "draft-only", folder: { address: "/pgtest-draft-only", target: { kind: "page", reference: unpublished } } },
    ]);
    expect(await resolvePublishedSiteNavigationFolderTarget(site.id, "public", "/pgtest-draft-only")).toBeNull();

    const pool = await requirePhiTestDatabase();
    await pool.query(
      `UPDATE phis.site_page_scopes SET tombstoned_at = NOW() WHERE site_id = $1 AND path = '/pgtest-docs/api'`,
      [site.id],
    );
    expect(await resolvePublishedSiteNavigationFolderTarget(site.id, "public", "/pgtest-docs")).toBeNull();
  });

  it("hands a Module Page on by reference, for the Site to check its route", async () => {
    const modulePage = createPhiPageReference({ kind: "module", ownerModuleId: "@phis/ui/modules/docs", presetKey: "start" });
    await publishNavigation(site, "public:modules", [
      { node: "module-docs", folder: { address: "/phis/docs", target: { kind: "page", reference: modulePage } } },
    ]);

    expect(await resolvePublishedSiteNavigationFolderTarget(site.id, "public", "/phis/docs")).toEqual({ reference: modulePage });
  });
});
