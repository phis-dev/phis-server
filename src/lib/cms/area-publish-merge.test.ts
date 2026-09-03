import { describe, expect, it } from "vitest";

import { mergePhiAreaTreeForPublish } from "./area-publish-merge";
import type { CmsAreaPresetWriteInput } from "./write-validation";

/*
 * The rule that keeps two open drafts from overtaking each other.
 *
 * The scenario worth holding on to is the ordering one: a Module publish, then a structure publish from
 * a draft that was started before it. Read naively, the second undoes the first.
 */

function buildAreaTree(overrides: Partial<CmsAreaPresetWriteInput> = {}): CmsAreaPresetWriteInput {
  return {
    area: "app",
    areaMask: 2,
    sourcePreset: { ownerModuleId: "@phis/ui", presetKey: "app-area-preset", sourcePresetVersion: 1 },
    preset: { config: { runtimeModules: [] } },
    regions: [],
    overlays: [],
    layoutNodes: [],
    contentWidgets: [],
    ...overrides,
  } as CmsAreaPresetWriteInput;
}

const publishedTree = buildAreaTree({
  preset: { config: { runtimeModules: ["@phis/ui/modules/avatar"], mediaSpaces: { user: { kinds: ["image"] } } } },
  regions: [{ regionType: 1 }] as CmsAreaPresetWriteInput["regions"],
});

describe("mergePhiAreaTreeForPublish", () => {
  it("keeps a structure publish from carrying its own stale Module selection", () => {
    const staleStructureDraft = buildAreaTree({
      preset: { config: { runtimeModules: [] } },
      regions: [{ regionType: 2 }] as CmsAreaPresetWriteInput["regions"],
    });

    const merged = mergePhiAreaTreeForPublish(publishedTree, staleStructureDraft, "structure");

    expect(merged.preset?.config).toEqual(publishedTree.preset?.config);
    expect(merged.regions).toEqual(staleStructureDraft.regions);
  });

  it("keeps a Module publish from carrying its own stale structure", () => {
    const staleModuleDraft = buildAreaTree({
      preset: { config: { runtimeModules: ["@acme/status/modules/status"] } },
      regions: [] as CmsAreaPresetWriteInput["regions"],
    });

    const merged = mergePhiAreaTreeForPublish(publishedTree, staleModuleDraft, "modules");

    expect(merged.preset?.config).toEqual(staleModuleDraft.preset?.config);
    expect(merged.regions).toEqual(publishedTree.regions);
  });

  it("survives both orderings without losing either half", () => {
    const moduleDraft = buildAreaTree({ preset: { config: { runtimeModules: ["@acme/status/modules/status"] } } });
    const structureDraft = buildAreaTree({
      preset: { config: { runtimeModules: [] } },
      regions: [{ regionType: 3 }] as CmsAreaPresetWriteInput["regions"],
    });

    const modulesFirst = mergePhiAreaTreeForPublish(
      mergePhiAreaTreeForPublish(publishedTree, moduleDraft, "modules"),
      structureDraft,
      "structure",
    );
    const structureFirst = mergePhiAreaTreeForPublish(
      mergePhiAreaTreeForPublish(publishedTree, structureDraft, "structure"),
      moduleDraft,
      "modules",
    );

    for (const result of [modulesFirst, structureFirst]) {
      expect(result.preset?.config).toEqual(moduleDraft.preset?.config);
      expect(result.regions).toEqual(structureDraft.regions);
    }
  });

  it("takes the draft whole when nothing is published yet", () => {
    const draft = buildAreaTree({ preset: { config: { runtimeModules: ["@acme/status/modules/status"] } } });

    expect(mergePhiAreaTreeForPublish(null, draft, "modules")).toBe(draft);
    expect(mergePhiAreaTreeForPublish(null, draft, "structure")).toBe(draft);
  });

  it("does not read an absent published config as an empty selection", () => {
    const withoutPreset = buildAreaTree({ preset: undefined });
    const draft = buildAreaTree({ preset: { config: { runtimeModules: ["@phis/ui/modules/avatar"] } } });

    const merged = mergePhiAreaTreeForPublish(withoutPreset, draft, "structure");

    expect(merged.preset?.config).toEqual({ runtimeModules: ["@phis/ui/modules/avatar"] });
  });
});
