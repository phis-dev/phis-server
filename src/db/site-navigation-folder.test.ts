import { describe, expect, it } from "vitest";

import { collectSiteCmsReferences } from "@/db/site-cms-references";
import { createPhiDraftCmsInstanceId, createPhiPresetCmsInstanceId } from "@/lib/cms/instance-id";
import { createPhiPageReference } from "@/lib/internal-references";
import { parseSiteNavigationOverlay } from "./site-navigation";

const container = createPhiDraftCmsInstanceId({ domain: "navigation", draftRevisionId: 41, sequence: 1 });
const moduleContainerId = createPhiPresetCmsInstanceId({
  domain: "navigation",
  ownerModuleId: "@phis/ui/modules/docs",
  presetKey: "docs-nav",
  nodeKey: "docs",
});
const sitePage = createPhiPageReference({ kind: "site", pageScopeId: 18 });
const modulePage = createPhiPageReference({ kind: "module", ownerModuleId: "@phis/ui/modules/docs", presetKey: "start" });

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

const parse = (value: unknown) => parseSiteNavigationOverlay(value, "public:header");

/**
 * A container's folder address and what it leads to (REFERENCES.md, "Folder addresses"). The target names a
 * Page or a sub-folder rather than a child of this Navigation, so another Navigation can take it over.
 */
describe("A Navigation container's folder", () => {
  it("leads to a Site Page or a Module Page by reference", () => {
    for (const reference of [sitePage, modulePage]) {
      const parsed = parse(overlay({ customItems: [customContainer({ address: "/docs", target: { kind: "page", reference } })] }));
      expect(parsed.customItems[0]?.folder).toEqual({ address: "/docs", target: { kind: "page", reference } });
    }
  });

  it("leads to a sub-folder beneath its own address", () => {
    const folder = { address: "/docs", target: { kind: "folder", address: "/docs/guides" } };
    expect(parse(overlay({ customItems: [customContainer(folder)] })).customItems[0]?.folder).toEqual(folder);
    expect(() => parse(overlay({
      customItems: [customContainer({ address: "/docs", target: { kind: "folder", address: "/manual/guides" } })],
    }))).toThrow(/beneath its address/);
  });

  it("may lead nowhere and keep its address, so a target chosen elsewhere can be carried to it", () => {
    const parsed = parse(overlay({ customItems: [customContainer({ address: "/docs", target: null })] }));
    expect(parsed.customItems[0]?.folder).toEqual({ address: "/docs", target: null });
    expect(() => parse(overlay({ customItems: [customContainer({ address: null, target: null })] })))
      .toThrow(/neither an address nor a target/);
  });

  it("may have no address, when the container's children share no folder", () => {
    const parsed = parse(overlay({ customItems: [customContainer({ address: null, target: { kind: "page", reference: sitePage } })] }));
    expect(parsed.customItems[0]?.folder?.address).toBeNull();
  });

  it("refuses a target that is neither a Page reference nor a canonical folder address", () => {
    for (const target of [
      { kind: "page", reference: "/docs/a" },
      { kind: "folder", address: "docs/guides" },
      { kind: "child", id: container },
    ]) {
      expect(() => parse(overlay({ customItems: [customContainer({ address: "/docs", target })] })), JSON.stringify(target))
        .toThrow(/target/);
    }
  });

  it("refuses an address that is not a canonical path below the Area root", () => {
    for (const address of ["/", "docs", "/docs/"]) {
      expect(() => parse(overlay({
        customItems: [customContainer({ address, target: { kind: "page", reference: sitePage } })],
      })), `"${address}" must be refused`).toThrow(/canonical path below the Area root/);
    }
  });

  it("is refused on anything but a container", () => {
    expect(() => parse(overlay({
      customItems: [{
        id: container,
        kind: "link",
        label: "Docs",
        target: { kind: "external", href: "https://example.org" },
        placement: { parentId: null, index: 0 },
        folder: { address: "/docs", target: { kind: "page", reference: sitePage } },
      }],
    }))).toThrow(/folder only for containers/);
  });

  it("stands on its own on a Module container's override, which is not empty then", () => {
    const folder = { address: "/docs", target: { kind: "page", reference: sitePage } };
    expect(parse(overlay({ itemOverrides: [{ id: moduleContainerId, folder }] })).itemOverrides[0])
      .toEqual({ id: moduleContainerId, folder });
  });

  it("indexes a Page target as a reference, like a link's target", () => {
    const parsed = parse(overlay({
      customItems: [customContainer({ address: "/docs", target: { kind: "page", reference: sitePage } })],
    }));
    const references = collectSiteCmsReferences(parsed, { targetAreaId: 1 });
    expect(references).toContainEqual(expect.objectContaining({
      location: "/customItems/0/folder/target/reference",
      reference: expect.objectContaining({ kind: "page" }),
    }));
  });
});
