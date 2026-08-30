import { describe, expect, it } from "vitest";

import { createPhiPresetCmsInstanceId } from "./instance-id";
import { validateCmsPageWriteInput } from "./write-validation";

const createTestId = (nodeKey: string) => createPhiPresetCmsInstanceId({
  domain: "page",
  ownerModuleId: "@phis/observability",
  presetKey: "admin-logs-page",
  nodeKey,
});
const OVERLAY_ID = createTestId("overlay/log-detail");
const ROOT_LAYOUT_ID = createTestId("layout/log-detail");
const DETAIL_WIDGET_ID = createTestId("widget/log-detail");

function buildPagePayload() {
  return {
    area: "admin",
    path: "/logs",
    sourcePreset: {
      ownerModuleId: "@phis/observability",
      presetKey: "admin-logs-page",
      sourcePresetVersion: 1,
    },
    page: {
      status: 1,
      visibilityMask: 4,
      contentRootLayoutNodeId: null,
    },
    overlays: [{
      id: OVERLAY_ID,
      overlayType: "modal",
      headerLayoutNodeId: null,
      bodyLayoutNodeId: ROOT_LAYOUT_ID,
      footerLayoutNodeId: null,
      status: 1,
      visibilityMask: 4,
      config: {
        signalRoutes: {
          listens: [{
            routeKey: "open-detail",
            capabilityId: "open",
            scope: "page",
            channel: "command",
            action: "open",
            valueType: "none",
            receiver: `cms:${OVERLAY_ID}`,
          }],
        },
      },
    }],
    layoutNodes: [{
      id: ROOT_LAYOUT_ID,
      parentLayoutNodeId: null,
      widgetType: "@phis/ui/modules/core/layouts/flex-vertical",
      slotIndex: 0,
      status: 1,
      visibilityMask: 4,
      config: {},
    }],
    contentWidgets: [{
      id: DETAIL_WIDGET_ID,
      parentLayoutNodeId: ROOT_LAYOUT_ID,
      widgetType: "@phis/ui/modules/core/widgets/text",
      slotIndex: 0,
      status: 1,
      visibilityMask: 4,
      config: {},
      contentId: null,
    }],
  };
}

describe("CMS overlay write validation", () => {
  it("accepts a page-owned modal with an explicit top-level root layout", () => {
    const result = validateCmsPageWriteInput(buildPagePayload());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.overlays).toHaveLength(1);
      expect(result.value.overlays[0]?.bodyLayoutNodeId).toBe(ROOT_LAYOUT_ID);
    }
  });

  it("rejects copied source URLs in Asset source config", () => {
    const payload = buildPagePayload();
    payload.contentWidgets[0]!.config = {
      sourceKind: "asset",
      assetId: 27,
      sourceUrl: "/media/sites/legacy/image.webp",
      background: {
        base: {
          kind: "image",
          sourceKind: "asset",
          assetId: 28,
          sourceUrl: "/media/sites/legacy/background.webp",
        },
      },
    };

    const result = validateCmsPageWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain(
        'contentWidgets[0].config.sourceUrl is forbidden when sourceKind is "asset".',
      );
      expect(result.details).toContain(
        'contentWidgets[0].config.background.base.sourceUrl is forbidden when sourceKind is "asset".',
      );
    }
  });

  it("requires the v1 overlays collection", () => {
    const payload = buildPagePayload() as Partial<ReturnType<typeof buildPagePayload>>;
    delete payload.overlays;

    const result = validateCmsPageWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("overlays must be an array.");
    }
  });

  it("requires the named v1 Overlay zones and rejects the former single root", () => {
    const payload = buildPagePayload();
    const overlay = payload.overlays[0] as Record<string, unknown>;
    overlay.rootLayoutNodeId = overlay.bodyLayoutNodeId;
    delete overlay.headerLayoutNodeId;
    delete overlay.bodyLayoutNodeId;
    delete overlay.footerLayoutNodeId;

    const result = validateCmsPageWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("overlays[0].bodyLayoutNodeId must be a canonical page PhiCmsInstanceId.");
      expect(result.details).toContain("overlays[0].headerLayoutNodeId must be null or a canonical page PhiCmsInstanceId.");
      expect(result.details).toContain("overlays[0].footerLayoutNodeId must be null or a canonical page PhiCmsInstanceId.");
    }
  });

  it("rejects a valid CMS id from another revision domain", () => {
    const payload = buildPagePayload();
    payload.overlays[0]!.id = createPhiPresetCmsInstanceId({
      domain: "area",
      ownerModuleId: "@phis/observability",
      presetKey: "admin-shell",
      nodeKey: "overlay/log-detail",
    });

    const result = validateCmsPageWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("overlays[0].id must be a canonical page PhiCmsInstanceId.");
    }
  });

  it("rejects an overlay root that is not top-level", () => {
    const payload = buildPagePayload();
    (payload.layoutNodes[0] as { parentLayoutNodeId: string | null }).parentLayoutNodeId = ROOT_LAYOUT_ID;

    const result = validateCmsPageWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain(`Overlay body root layout ${ROOT_LAYOUT_ID} must be a top-level layout.`);
    }
  });

  it("rejects sharing one root between an overlay and page flow", () => {
    const payload = buildPagePayload();
    (payload.page as { contentRootLayoutNodeId: string | null }).contentRootLayoutNodeId = ROOT_LAYOUT_ID;

    const result = validateCmsPageWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain(
        `Root layout ${ROOT_LAYOUT_ID} is shared by overlay ${OVERLAY_ID} body and a Page Region.`,
      );
    }
  });
});
