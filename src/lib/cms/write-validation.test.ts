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
    controllerSettings: [],
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

/**
 * The write path against the whole access vocabulary, because it once knew only part of it: a Page bound
 * to a Site group or to an Add-on role could not be saved at all, while the evaluator both processes
 * share decided that same policy without difficulty.
 */
describe("CMS access policy write validation", () => {
  function withPagePolicy(accessPolicy: unknown) {
    const payload = buildPagePayload();
    (payload.page as Record<string, unknown>).accessPolicy = accessPolicy;
    return validateCmsPageWriteInput(payload);
  }

  function withNodePolicy(accessPolicy: unknown) {
    const payload = buildPagePayload();
    payload.contentWidgets[0]!.config = { accessPolicy };
    return validateCmsPageWriteInput(payload);
  }

  it.each([
    ["anyone", { access: "anyone" }],
    ["anonymous", { access: "anonymous" }],
    ["authenticated", { access: "authenticated" }],
    ["roles", { access: "roles", providerId: "@phis/server/core", allowedRoleFlags: 3 }],
    ["groups", { access: "groups", providerId: "@phis/server/core", allowedGroupKeys: ["press-team"] }],
    ["addon-roles", { access: "addon-roles", providerId: "@acme/shop", allowedRoles: ["shop-manager"] }],
  ])("accepts a %s policy on a Page", (_shape, accessPolicy) => {
    const result = withPagePolicy(accessPolicy);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.page?.accessPolicy).toEqual(accessPolicy);
    }
  });

  it("accepts a groups policy on a node's config", () => {
    const result = withNodePolicy({
      access: "groups",
      providerId: "@phis/server/core",
      allowedGroupKeys: ["press-team", "board"],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts an addon-roles policy on a Command Toolbar button", () => {
    const payload = buildPagePayload();
    payload.contentWidgets[0]!.config = {
      buttons: [{
        accessPolicy: { access: "addon-roles", providerId: "@acme/shop", allowedRoles: ["shop-manager"] },
      }],
    };

    expect(validateCmsPageWriteInput(payload).ok).toBe(true);
  });

  it("stores each named group and role once", () => {
    const result = withPagePolicy({
      access: "groups",
      providerId: "@phis/server/core",
      allowedGroupKeys: ["press-team", "press-team"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.page?.accessPolicy).toEqual({
        access: "groups",
        providerId: "@phis/server/core",
        allowedGroupKeys: ["press-team"],
      });
    }
  });

  /*
   * An Add-on that is not installed is not a bad policy. Its claims are simply absent, so the evaluator
   * matches nobody and the surface stays hidden until the Add-on comes back -- refusing the write would
   * instead make the Page unsavable for as long as the Add-on is off, and would lose what the author meant.
   */
  it("accepts a policy naming an Add-on this Server has never seen", () => {
    const result = withPagePolicy({
      access: "addon-roles",
      providerId: "@nobody/never-installed",
      allowedRoles: ["reviewer"],
    });

    expect(result.ok).toBe(true);
  });

  it.each([
    ["an unknown access kind", { access: "everyone" }],
    ["a provider id that is not package-qualified", {
      access: "groups", providerId: "core", allowedGroupKeys: ["press-team"],
    }],
    ["a groups policy naming no group", {
      access: "groups", providerId: "@phis/server/core", allowedGroupKeys: [],
    }],
    ["a group key outside the stored grammar", {
      access: "groups", providerId: "@phis/server/core", allowedGroupKeys: ["Press Team"],
    }],
    ["a group key that is not a string", {
      access: "groups", providerId: "@phis/server/core", allowedGroupKeys: [7],
    }],
    ["an addon-roles policy naming no role", {
      access: "addon-roles", providerId: "@acme/shop", allowedRoles: [],
    }],
    ["a role name outside the manifest grammar", {
      access: "addon-roles", providerId: "@acme/shop", allowedRoles: ["Shop Manager"],
    }],
    ["a roles policy with no flags set", {
      access: "roles", providerId: "@phis/server/core", allowedRoleFlags: 0,
    }],
    ["a roles policy with negative flags", {
      access: "roles", providerId: "@phis/server/core", allowedRoleFlags: -1,
    }],
    ["a groups policy carrying role flags instead of keys", {
      access: "groups", providerId: "@phis/server/core", allowedRoleFlags: 3,
    }],
  ])("refuses %s", (_reason, accessPolicy) => {
    const result = withPagePolicy(accessPolicy);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("page.accessPolicy is invalid.");
    }
  });

  it("refuses a malformed policy on a node rather than reading it as public", () => {
    const result = withNodePolicy({ access: "groups", providerId: "@phis/server/core" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("contentWidgets[0].config.accessPolicy is invalid.");
    }
  });

  it("refuses a policy that is not an object at all", () => {
    const result = withPagePolicy("authenticated");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("page.accessPolicy must be an access policy object.");
    }
  });
});

/*
 * A tree tells its Controllers whom they answer into, beside the routes it writes for its nodes. One
 * reader for a Page and an Area, with the same rules as a node's routes.
 */
describe("CMS Controller settings write validation", () => {
  const CONTROLLER_TYPE = "@phis/ui/modules/localization/controller/default";
  function withSettings(controllerSettings: unknown) {
    return { ...buildPagePayload(), controllerSettings };
  }
  function openRoute(receiver: string) {
    return {
      signalRoutes: {
        emits: [{
          routeKey: "controller-open",
          capabilityId: "dialogOpen",
          scope: "page",
          channel: "dialog",
          action: "activate",
          valueType: "none",
          receiver,
        }],
      },
    };
  }

  it("keeps a Page's setting whose routes name the Page's own nodes", () => {
    const result = validateCmsPageWriteInput(withSettings([{
      type: CONTROLLER_TYPE,
      instanceKey: "default",
      mountScope: "page",
      config: openRoute(`cms:${OVERLAY_ID}`),
    }]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.controllerSettings).toEqual([{
        type: CONTROLLER_TYPE,
        instanceKey: "default",
        mountScope: "page",
        config: openRoute(`cms:${OVERLAY_ID}`),
      }]);
    }
  });

  it("refuses a tree that leaves the field out", () => {
    const payload: Record<string, unknown> = buildPagePayload();
    delete payload.controllerSettings;
    const result = validateCmsPageWriteInput(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.details).toContain("controllerSettings must be an array.");
  });

  it("refuses a setting in another scope, an enabled switch, a twin and a route to nothing", () => {
    const result = validateCmsPageWriteInput(withSettings([
      { type: CONTROLLER_TYPE, instanceKey: "default", mountScope: "area", config: null },
      { type: CONTROLLER_TYPE, instanceKey: "default", mountScope: "page", enabled: true, config: null },
      {
        type: CONTROLLER_TYPE,
        instanceKey: "other",
        mountScope: "page",
        config: openRoute(`cms:${createTestId("overlay/gone")}`),
      },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toEqual(expect.arrayContaining([
        'controllerSettings[0].mountScope must be "page" in a page tree.',
        "controllerSettings[1].enabled is not part of a stored Controller setting.",
        `controllerSettings configures "${CONTROLLER_TYPE}:default" twice.`,
        "controllerSettings[2].config.signalRoutes.emits[0] targets an unknown CMS instance.",
      ]));
    }
  });
});
