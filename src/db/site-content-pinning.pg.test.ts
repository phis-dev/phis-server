import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { PhiCmsStatus } from "@phis/contracts/cms";
import { createPhiPresetCmsInstanceId } from "@/lib/cms/instance-id";
import { validateCmsPageWriteInput } from "@/lib/cms/write-validation";
import {
  deleteSitePageDraftRevision,
  getResolvedSitePageTree,
  publishSitePageRevision,
  saveSitePageDraftRevision,
} from "./site-pages";

/**
 * A revision shows the content versions it pins.
 *
 * Every save of a content-bound Widget appends a content version. It used to move one pointer on the
 * content row that every revision read through, so the published Page showed the draft's text the
 * moment the draft was saved, and discarding the draft could not take it back.
 */
const createTestId = (nodeKey: string) => createPhiPresetCmsInstanceId({
  domain: "page",
  ownerModuleId: "@phis/pgtest",
  presetKey: "content-pinning",
  nodeKey,
});
const ROOT_LAYOUT_ID = createTestId("layout/root");
const TEXT_WIDGET_ID = createTestId("widget/text");

function pageInput(
  path: string,
  text: string,
  pin: { contentId: number | null; contentVersionId: number | null },
) {
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
      contentRootLayoutNodeId: ROOT_LAYOUT_ID,
      footerTopRootLayoutNodeId: null,
      drawerRightRootLayoutNodeId: null,
      layoutConfig: { pageRegionConfigs: {} },
    },
    overlays: [],
    layoutNodes: [{
      id: ROOT_LAYOUT_ID,
      parentLayoutNodeId: null,
      widgetType: "@phis/ui/modules/core/layouts/flex-vertical",
      slotIndex: 0,
      status: 1,
      visibilityMask: 1,
      config: {},
    }],
    contentWidgets: [{
      id: TEXT_WIDGET_ID,
      parentLayoutNodeId: ROOT_LAYOUT_ID,
      widgetType: "@phis/ui/modules/core/widgets/simple-text",
      slotIndex: 0,
      status: 1,
      visibilityMask: 1,
      config: { text },
      contentId: pin.contentId,
      contentVersionId: pin.contentVersionId,
      contentBinding: { storage: "text", sourceField: "text" },
    }],
  });
  if (!validated.ok) throw new Error(`Invalid test page input: ${validated.error}`);
  return validated.value;
}

describe("content versions pinned by revisions against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("content-pinning");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function publishedWidget(path: string) {
    const tree = await getResolvedSitePageTree(site.id, 1, { kind: "path", path });
    const widget = tree?.contentWidgets.find((entry) => entry.id === TEXT_WIDGET_ID);
    if (!widget) throw new Error(`No published text widget on ${path}.`);
    return widget;
  }

  async function publish(path: string, revisionId: number) {
    await publishSitePageRevision(site.id, {
      areaMask: 1,
      address: { kind: "path", path },
      revisionId,
    });
  }

  it("keeps the published text while a draft changes it, and after the draft is discarded", async () => {
    const path = `/pgtest-pinning-${Math.random().toString(36).slice(2)}`;
    const created = await saveSitePageDraftRevision(
      site.id,
      pageInput(path, "Eins", { contentId: null, contentVersionId: null }),
      { createOnly: true },
    );
    await publish(path, created.revisionId);
    const live = await publishedWidget(path);
    expect(live.contentVersionId).not.toBeNull();
    expect(live.resolvedContent?.textFields.text?.source).toBe("Eins");

    await saveSitePageDraftRevision(
      site.id,
      pageInput(path, "Zwei", { contentId: live.contentId, contentVersionId: live.contentVersionId }),
    );
    expect((await publishedWidget(path)).resolvedContent?.textFields.text?.source).toBe("Eins");

    await deleteSitePageDraftRevision(site.id, { areaMask: 1, address: { kind: "path", path } });
    expect((await publishedWidget(path)).resolvedContent?.textFields.text?.source).toBe("Eins");
  });

  it("shows the draft's text once the draft is published, on the same content row", async () => {
    const path = `/pgtest-pinning-${Math.random().toString(36).slice(2)}`;
    const created = await saveSitePageDraftRevision(
      site.id,
      pageInput(path, "Eins", { contentId: null, contentVersionId: null }),
      { createOnly: true },
    );
    await publish(path, created.revisionId);
    const live = await publishedWidget(path);

    const draft = await saveSitePageDraftRevision(
      site.id,
      pageInput(path, "Zwei", { contentId: live.contentId, contentVersionId: live.contentVersionId }),
    );
    await publish(path, draft.revisionId);

    const republished = await publishedWidget(path);
    expect(republished.contentId).toBe(live.contentId);
    expect(republished.contentVersionId).not.toBe(live.contentVersionId);
    expect(republished.resolvedContent?.textFields.text?.source).toBe("Zwei");
  });

  it("drops a pin that is not a version of the widget's content", async () => {
    const path = `/pgtest-pinning-${Math.random().toString(36).slice(2)}`;
    const first = `/pgtest-pinning-${Math.random().toString(36).slice(2)}`;
    const other = await saveSitePageDraftRevision(
      site.id,
      pageInput(first, "Fremd", { contentId: null, contentVersionId: null }),
      { createOnly: true },
    );
    await publish(first, other.revisionId);
    const foreign = await publishedWidget(first);

    const input = pageInput(path, "Eins", { contentId: null, contentVersionId: null });
    const unbound = {
      ...input,
      contentWidgets: input.contentWidgets.map((widget) => ({
        ...widget,
        contentBinding: null,
        contentId: required(foreign.contentId),
        contentVersionId: required(foreign.contentVersionId) + 1_000_000,
      })),
    };
    const created = await saveSitePageDraftRevision(site.id, unbound, { createOnly: true });
    await publish(path, created.revisionId);

    const widget = await publishedWidget(path);
    expect(widget.contentId).toBeNull();
    expect(widget.contentVersionId).toBeNull();
    expect(widget.resolvedContent).toBeNull();
  });
});

function required(value: number | null) {
  if (value == null) throw new Error("Expected a pinned content id.");
  return value;
}
