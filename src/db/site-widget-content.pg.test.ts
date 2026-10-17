import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  withPhiTestClient,
  type PhiTestSite,
} from "../../test/pg/harness";
import { PhiCmsStatus } from "@phis/contracts/cms";
import { createPhiDraftCmsInstanceId, createPhiPresetCmsInstanceId } from "@/lib/cms/instance-id";
import { validateCmsPageWriteInput } from "@/lib/cms/write-validation";
import {
  deleteSitePageOverride,
  getResolvedSitePageTree,
  getSiteCurrentPageDraft,
  getSitePageRevisionReview,
  publishSitePageRevision,
  saveSitePageDraftRevision,
} from "./site-pages";
import {
  deleteOrphanedSiteWidgetContentWithDb,
  publishSiteWidgetContent,
  SiteContentConflictError,
  submitSiteWidgetContent,
  withdrawSiteWidgetContent,
  writeSiteWidgetContentWithClient,
} from "./site-widget-content";

/**
 * Content publishes apart from structure (CONTENT.md).
 *
 * A Widget's text is bound to its instance and lives in `site_content`; the revision tree keeps neither
 * the text nor a pin. Publishing the Page puts structure live, publishing the content puts the words live,
 * and a placeholder the Builder typed is never live until somebody publishes it.
 */
let sequence = 0;
const draftId = () => createPhiDraftCmsInstanceId({ domain: "page", draftRevisionId: 7, sequence: ++sequence });

function pageInput(
  path: string,
  ids: { root: string; text: string },
  text: string | undefined,
  base: number | null,
  sourcePreset: { ownerModuleId: string; presetKey: string; sourcePresetVersion: number } | null = null,
  extraWidgets: { id: string; text: string }[] = [],
) {
  const validated = validateCmsPageWriteInput({
    area: "public",
    path,
    sourcePreset,
    page: {
      status: PhiCmsStatus.Published,
      flags: 0,
      visibilityMask: 1,
      heroRootLayoutNodeId: null,
      headerBottomRootLayoutNodeId: null,
      siderRightRootLayoutNodeId: null,
      contentRootLayoutNodeId: ids.root,
      footerTopRootLayoutNodeId: null,
      drawerRightRootLayoutNodeId: null,
      layoutConfig: { pageRegionConfigs: {} },
    },
    overlays: [],
    layoutNodes: [{
      id: ids.root,
      parentLayoutNodeId: null,
      widgetType: "@phis/ui/modules/core/layouts/flex-vertical",
      slotIndex: 0,
      status: 1,
      visibilityMask: 1,
      config: {},
    }],
    contentWidgets: [{
      id: ids.text,
      parentLayoutNodeId: ids.root,
      widgetType: "@phis/ui/modules/core/widgets/simple-text",
      slotIndex: 0,
      status: 1,
      visibilityMask: 1,
      config: text === undefined ? {} : { text },
      contentVersionId: base,
      contentBinding: { storage: "text", sourceField: "text" },
    }, ...extraWidgets.map((widget, index) => ({
      id: widget.id,
      parentLayoutNodeId: ids.root,
      widgetType: "@phis/ui/modules/core/widgets/simple-text",
      slotIndex: index + 1,
      status: 1,
      visibilityMask: 1,
      config: { text: widget.text },
      contentVersionId: null,
      contentBinding: { storage: "text" as const, sourceField: "text" },
    }))],
    controllerSettings: [],
  });
  if (!validated.ok) throw new Error(`Invalid test page input: ${validated.error}`);
  return validated.value;
}

describe("Widget content published apart from structure, against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("widget-content");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function createPage(text: string) {
    const path = `/pgtest-content-${Math.random().toString(36).slice(2)}`;
    const ids = { root: draftId(), text: draftId() };
    const created = await saveSitePageDraftRevision(site.id, pageInput(path, ids, text, null), { createOnly: true });
    await publishSitePageRevision(site.id, { areaMask: 1, address: { kind: "path", path }, revisionId: created.revisionId });
    return { path, ids };
  }

  async function liveWidget(path: string, id: string) {
    const tree = await getResolvedSitePageTree(site.id, 1, { kind: "path", path });
    const widget = tree?.contentWidgets.find((entry) => entry.id === id);
    if (!widget) throw new Error(`No live widget ${id} on ${path}.`);
    return widget;
  }

  /** The Page as an editor reads it: the Working Draft where there is one, the published revision otherwise. */
  async function draftWidget(path: string, id: string) {
    const address = { kind: "path" as const, path };
    const draft = await getSiteCurrentPageDraft(site.id, { areaMask: 1, address });
    const tree = draft?.tree ?? (await getSitePageRevisionReview(site.id, await publishedRevisionId(path), {
      areaMask: 1,
      address,
    }))?.tree;
    const widget = tree?.contentWidgets.find((entry) => entry.id === id);
    if (!widget) throw new Error(`No draft widget ${id} on ${path}.`);
    return widget;
  }

  async function publishedRevisionId(path: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ published_revision_id: number }>(
      `SELECT published_revision_id FROM phis.site_page_scopes WHERE site_id = $1 AND path = $2`,
      [site.id, path],
    );
    return rows[0]!.published_revision_id;
  }

  /** A structure save on top of whatever Working Draft the Page has, as the Builder makes it. */
  async function save(path: string, ids: { root: string; text: string }, text: string | undefined, base: number | null) {
    const current = await getSiteCurrentPageDraft(site.id, { areaMask: 1, address: { kind: "path", path } });
    return saveSitePageDraftRevision(site.id, {
      ...pageInput(path, ids, text, base),
      ...(current ? { draft: current.draft } : {}),
    });
  }

  async function contentRow(instanceId: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{
      id: number;
      current_version_id: number | null;
      published_version_id: number | null;
      submitted_version_id: number | null;
      versions: number;
    }>(
      `SELECT c.id, c.current_version_id, c.published_version_id, c.submitted_version_id,
              (SELECT COUNT(*)::int FROM phis.site_content_versions v WHERE v.content_id = c.id) AS versions
       FROM phis.site_content c
       WHERE c.site_id = $1 AND c.instance_id = $2`,
      [site.id, instanceId],
    );
    return rows[0] ?? null;
  }

  async function storedTreeText(path: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ tree_json: { contentWidgets: Array<Record<string, unknown>> } }>(
      `SELECT r.tree_json
       FROM phis.site_page_scopes s
       JOIN phis.site_page_revisions r ON r.id = s.published_revision_id
       WHERE s.site_id = $1 AND s.path = $2`,
      [site.id, path],
    );
    return rows[0]?.tree_json.contentWidgets[0] ?? null;
  }

  it("keeps the Builder's placeholder off the live Site until the content is published", async () => {
    const { path, ids } = await createPage("Lorem ipsum");

    const stored = await storedTreeText(path);
    expect(stored?.config).toEqual({});
    expect(stored).not.toHaveProperty("contentId");
    expect(stored).not.toHaveProperty("contentVersionId");

    const live = await liveWidget(path, ids.text);
    expect(live.resolvedContent).toBeNull();
    expect(live.config.text).toBeUndefined();

    const draft = await draftWidget(path, ids.text);
    expect(draft.config.text).toBe("Lorem ipsum");
    expect(draft.contentVersionId).not.toBeNull();

    const row = await contentRow(ids.text);
    const published = await publishSiteWidgetContent({
      siteId: site.id,
      contentId: row!.id,
      versionId: row!.current_version_id!,
    });
    expect(published.ok).toBe(true);
    expect((await liveWidget(path, ids.text)).resolvedContent?.textFields.text?.source).toBe("Lorem ipsum");
  });

  it("publishes structure without the text a draft changed, and the text without the structure", async () => {
    const { path, ids } = await createPage("Eins");
    const first = await contentRow(ids.text);
    await publishSiteWidgetContent({ siteId: site.id, contentId: first!.id, versionId: first!.current_version_id! });

    const saved = await save(path, ids, "Zwei", first!.current_version_id);
    await publishSitePageRevision(site.id, { areaMask: 1, address: { kind: "path", path }, revisionId: saved.revisionId });
    expect((await liveWidget(path, ids.text)).resolvedContent?.textFields.text?.source).toBe("Eins");

    const second = await contentRow(ids.text);
    expect(second!.current_version_id).not.toBe(first!.current_version_id);
    await publishSiteWidgetContent({ siteId: site.id, contentId: second!.id, versionId: second!.current_version_id! });
    expect((await liveWidget(path, ids.text)).resolvedContent?.textFields.text?.source).toBe("Zwei");

    await withdrawSiteWidgetContent({ siteId: site.id, contentId: second!.id });
    expect((await liveWidget(path, ids.text)).resolvedContent).toBeNull();
  });

  it("writes no version for a save that did not change the text", async () => {
    const { path, ids } = await createPage("Gleich");
    const before = await contentRow(ids.text);
    await save(path, ids, "Gleich", before!.current_version_id);
    await save(path, ids, undefined, before!.current_version_id);
    expect((await contentRow(ids.text))!.versions).toBe(before!.versions);
  });

  it("refuses a changed text that does not build on the current version, and lets an unchanged one pass", async () => {
    const { path, ids } = await createPage("Basis");
    const base = (await contentRow(ids.text))!.current_version_id!;
    await save(path, ids, "Autorin", base);
    const before = await contentRow(ids.text);

    await expect(save(path, ids, "Builder", base))
      .rejects.toBeInstanceOf(SiteContentConflictError);
    expect((await contentRow(ids.text))!.current_version_id).toBe(before!.current_version_id);

    // The Builder still holds the text they read; their structure save must not be refused for it.
    await save(path, ids, "Basis", base);
    expect((await contentRow(ids.text))!.current_version_id).toBe(before!.current_version_id);
    expect((await draftWidget(path, ids.text)).config.text).toBe("Autorin");
  });

  it("keeps a submission on the version that was submitted, and clears it with the publish", async () => {
    const { path, ids } = await createPage("Eingereicht");
    const submittedVersion = (await contentRow(ids.text))!.current_version_id!;
    const row = await contentRow(ids.text);
    expect((await submitSiteWidgetContent({ siteId: site.id, contentId: row!.id, versionId: submittedVersion + 999 })).ok)
      .toBe(false);
    expect((await submitSiteWidgetContent({ siteId: site.id, contentId: row!.id, versionId: submittedVersion })).ok)
      .toBe(true);

    await save(path, ids, "Weitergeschrieben", submittedVersion);
    const after = await contentRow(ids.text);
    expect(after!.submitted_version_id).toBe(submittedVersion);
    expect(after!.current_version_id).not.toBe(submittedVersion);

    await publishSiteWidgetContent({ siteId: site.id, contentId: row!.id, versionId: submittedVersion });
    const published = await contentRow(ids.text);
    expect(published!.submitted_version_id).toBeNull();
    expect((await liveWidget(path, ids.text)).resolvedContent?.textFields.text?.source).toBe("Eingereicht");
  });

  it("moves the Site read marker on a content publish and not on a save", async () => {
    const pool = await requirePhiTestDatabase();
    const marker = async () => (await pool.query<{ marker: string }>(
      `SELECT marker::text FROM phis.site_read_marker WHERE site_id = $1`,
      [site.id],
    )).rows[0]?.marker ?? null;
    const { path, ids } = await createPage("Markiert");
    const row = await contentRow(ids.text);

    const beforeSave = await marker();
    await save(path, ids, "Markiert neu", row!.current_version_id);
    expect(await marker()).toBe(beforeSave);

    const current = (await contentRow(ids.text))!.current_version_id!;
    await publishSiteWidgetContent({ siteId: site.id, contentId: row!.id, versionId: current });
    expect(await marker()).not.toBe(beforeSave);
  });

  it("sweeps the content of a removed Site widget, never a preset node's", async () => {
    const presetId = createPhiPresetCmsInstanceId({
      domain: "page",
      ownerModuleId: "@phis/pgtest",
      presetKey: "widget-content",
      nodeKey: `widget/${Math.random()}`,
    });
    const orphanId = draftId();
    await withPhiTestClient(async (client) => {
      await client.query("BEGIN");
      for (const instanceId of [presetId, orphanId]) {
        await writeSiteWidgetContentWithClient(client, {
          siteId: site.id,
          instanceId,
          storage: "text",
          value: "Verwaist",
          baseVersionId: null,
          slug: `pgtest-${instanceId}`,
          referenceAreaId: 1,
        });
      }
      await deleteOrphanedSiteWidgetContentWithDb(client, site.id, [presetId, orphanId]);
      await client.query("COMMIT");
    });
    expect(await contentRow(presetId)).not.toBeNull();
    expect(await contentRow(orphanId)).toBeNull();
  });

  it("takes a Module's Page back to its preset, keeping the content of the preset's nodes", async () => {
    const preset = { ownerModuleId: "@phis/pgtest/content", presetKey: `reset-${Math.random()}`, sourcePresetVersion: 1 };
    const presetNode = (nodeKey: string) => createPhiPresetCmsInstanceId({
      domain: "page",
      ownerModuleId: preset.ownerModuleId,
      presetKey: preset.presetKey,
      nodeKey,
    });
    const ids = { root: presetNode("layout/root"), text: presetNode("widget/text") };
    const added = draftId();
    const saved = await saveSitePageDraftRevision(
      site.id,
      pageInput("/", ids, "Shipped text", null, preset, [{ id: added, text: "Added by the Builder" }]),
    );
    await publishSitePageRevision(site.id, {
      areaMask: 1,
      address: { kind: "preset", ownerModuleId: preset.ownerModuleId, presetKey: preset.presetKey },
      revisionId: saved.revisionId,
    });
    // A preset node keeps its shipped text in the tree; the Site's own Widget got a row.
    expect(await contentRow(ids.text)).toBeNull();
    expect(await contentRow(added)).not.toBeNull();

    // The Editor writes content for the preset's node, as an Author would.
    await withPhiTestClient(async (client) => {
      await client.query("BEGIN");
      await writeSiteWidgetContentWithClient(client, {
        siteId: site.id,
        instanceId: ids.text,
        storage: "text",
        value: "Written by an Author",
        baseVersionId: null,
        slug: `pgtest-${ids.text}`,
        referenceAreaId: 1,
      });
      await client.query("COMMIT");
    });

    expect(await deleteSitePageOverride(site.id, { areaMask: 1, sourcePreset: preset })).toEqual({ deleted: true });
    expect(await contentRow(ids.text)).not.toBeNull();
    expect(await contentRow(added)).toBeNull();
    const pool = await requirePhiTestDatabase();
    const { rowCount } = await pool.query(
      `SELECT 1 FROM phis.site_page_scopes WHERE site_id = $1 AND owner_module_id = $2 AND preset_key = $3`,
      [site.id, preset.ownerModuleId, preset.presetKey],
    );
    expect(rowCount).toBe(0);
  });
});
