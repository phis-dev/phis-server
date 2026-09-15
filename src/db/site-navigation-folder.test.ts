import { describe, expect, it } from "vitest";

import { createPhiDraftCmsInstanceId, createPhiPresetCmsInstanceId } from "@/lib/cms/instance-id";
import { parseSiteNavigationOverlay } from "./site-navigation";

const draftId = (sequence: number) =>
  createPhiDraftCmsInstanceId({ domain: "navigation", draftRevisionId: 41, sequence });
const moduleContainerId = createPhiPresetCmsInstanceId({
  domain: "navigation",
  ownerModuleId: "@phis/ui/modules/docs",
  presetKey: "docs-nav",
  nodeKey: "docs",
});

const container = draftId(1);
const guides = draftId(2);

function overlay(parts: { customItems?: unknown[]; itemOverrides?: unknown[] }) {
  return {
    navKey: "public:header",
    itemOverrides: parts.itemOverrides ?? [],
    customItems: parts.customItems ?? [],
    tombstones: [],
  };
}

function customContainer(folder: unknown) {
  return {
    id: container,
    kind: "container",
    label: "Docs",
    placement: { parentId: null, index: 0 },
    ...(folder === undefined ? {} : { folder }),
  };
}

/**
 * A container's folder address and the child it leads to (TODOS.md, "Folder addresses"). The server
 * keeps the form strict; which child is a direct one is the Builder's write rule and the lookup's read.
 */
describe("A Navigation container's folder", () => {
  it("is kept on a custom container, with its address and its choice", () => {
    const parsed = parseSiteNavigationOverlay(
      overlay({ customItems: [customContainer({ address: "/docs", choice: guides })] }),
      "public:header",
    );

    expect(parsed.customItems[0]?.folder).toEqual({ address: "/docs", choice: guides });
  });

  it("may have no address, when the container's children share no folder", () => {
    const parsed = parseSiteNavigationOverlay(
      overlay({ customItems: [customContainer({ address: null, choice: guides })] }),
      "public:header",
    );

    expect(parsed.customItems[0]?.folder).toEqual({ address: null, choice: guides });
  });

  it("is refused on anything but a container", () => {
    expect(() => parseSiteNavigationOverlay(overlay({
      customItems: [{
        id: container,
        kind: "link",
        label: "Docs",
        target: { kind: "external", href: "https://example.org" },
        placement: { parentId: null, index: 0 },
        folder: { address: "/docs", choice: guides },
      }],
    }), "public:header")).toThrow(/folder only for containers/);
  });

  it("refuses an address that is not a canonical path below the Area root", () => {
    for (const address of ["/", "docs", "/docs/"]) {
      expect(() => parseSiteNavigationOverlay(
        overlay({ customItems: [customContainer({ address, choice: guides })] }),
        "public:header",
      ), `"${address}" must be refused`).toThrow(/canonical path below the Area root/);
    }
  });

  it("refuses a choice that is not a Navigation instance id", () => {
    expect(() => parseSiteNavigationOverlay(
      overlay({ customItems: [customContainer({ address: "/docs", choice: "guides" })] }),
      "public:header",
    )).toThrow(/choice/);
  });

  it("stands on its own on a Module container's override, which is not empty then", () => {
    const parsed = parseSiteNavigationOverlay(
      overlay({ itemOverrides: [{ id: moduleContainerId, folder: { address: "/docs", choice: guides } }] }),
      "public:header",
    );

    expect(parsed.itemOverrides[0]).toEqual({ id: moduleContainerId, folder: { address: "/docs", choice: guides } });
  });
});
