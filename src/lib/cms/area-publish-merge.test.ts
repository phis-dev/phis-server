import { describe, expect, it } from "vitest";

import { mergePhiAreaTreeForPublish } from "./area-publish-merge";
import type { CmsAreaPresetWriteInput } from "./write-validation";

/*
 * The rule that keeps two open drafts from overtaking each other.
 *
 * An Area is written from two workspaces: the structure draft owns the tree and `config.shell`, the
 * Module draft owns `config.modules`. The scenario worth holding on to is the ordering one -- a Module
 * publish, then a structure publish from a draft that was started before it. Read naively, the second
 * undoes the first.
 */

function buildAreaTree(overrides: Partial<CmsAreaPresetWriteInput> = {}): CmsAreaPresetWriteInput {
  return {
    area: "app",
    areaMask: 2,
    sourcePreset: { ownerModuleId: "@phis/ui", presetKey: "app-area-preset", sourcePresetVersion: 1 },
    preset: { config: { modules: { runtimeModules: [] } } },
    regions: [],
    overlays: [],
    layoutNodes: [],
    contentWidgets: [],
    ...overrides,
  } as CmsAreaPresetWriteInput;
}

function configOf(tree: CmsAreaPresetWriteInput) {
  return (tree.preset?.config ?? {}) as {
    shell?: Record<string, unknown>;
    modules?: Record<string, unknown>;
    legacy?: Record<string, unknown>;
  };
}

const publishedTree = buildAreaTree({
  preset: {
    config: {
      shell: { rootRoute: { mode: "redirect" } },
      modules: {
        runtimeModules: ["@phis/ui/modules/avatar"],
        mediaSpaces: { user: { kinds: ["image"] } },
      },
    },
  },
  regions: [{ regionType: 1 }] as CmsAreaPresetWriteInput["regions"],
});

describe("mergePhiAreaTreeForPublish", () => {
  it("keeps a structure publish from carrying its own stale Module selection", () => {
    const draft = buildAreaTree({
      preset: { config: { modules: { runtimeModules: [] } } },
      regions: [{ regionType: 2 }] as CmsAreaPresetWriteInput["regions"],
    });

    const merged = mergePhiAreaTreeForPublish(publishedTree, draft, "structure");

    expect(merged.regions).toEqual(draft.regions);
    expect(configOf(merged).modules).toEqual(configOf(publishedTree).modules);
  });

  it("keeps a Module publish from carrying its own stale structure", () => {
    const draft = buildAreaTree({
      preset: { config: { modules: { runtimeModules: ["@acme/status/modules/status"] } } },
      regions: [] as CmsAreaPresetWriteInput["regions"],
    });

    const merged = mergePhiAreaTreeForPublish(publishedTree, draft, "modules");

    expect(merged.regions).toEqual(publishedTree.regions);
    expect(configOf(merged).modules).toEqual(configOf(draft).modules);
  });

  it("leaves the Shell namespace to the structure draft", () => {
    const structureDraft = buildAreaTree({
      preset: { config: { shell: { rootRoute: { mode: "landing" } } } },
    });
    const moduleDraft = buildAreaTree({
      preset: { config: { modules: { runtimeModules: ["@acme/status/modules/status"] } } },
    });

    // The structure draft moves it.
    expect(
      configOf(mergePhiAreaTreeForPublish(publishedTree, structureDraft, "structure")).shell,
    ).toEqual({ rootRoute: { mode: "landing" } });

    // The Module draft, which does not carry one at all, leaves what is published standing.
    expect(
      configOf(mergePhiAreaTreeForPublish(publishedTree, moduleDraft, "modules")).shell,
    ).toEqual({ rootRoute: { mode: "redirect" } });
  });

  it("survives both orderings without losing either half", () => {
    const moduleDraft = buildAreaTree({
      preset: { config: { modules: { runtimeModules: ["@acme/status/modules/status"] } } },
    });
    const structureDraft = buildAreaTree({
      preset: { config: { shell: { rootRoute: { mode: "landing" } } } },
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
      expect(configOf(result).modules).toEqual(configOf(moduleDraft).modules);
      expect(configOf(result).shell).toEqual(configOf(structureDraft).shell);
      expect(result.regions).toEqual(structureDraft.regions);
    }
  });

  it("takes the draft whole when nothing is published yet", () => {
    const draft = buildAreaTree({
      preset: { config: { modules: { runtimeModules: ["@acme/status/modules/status"] } } },
    });

    expect(mergePhiAreaTreeForPublish(null, draft, "modules")).toBe(draft);
    expect(mergePhiAreaTreeForPublish(null, draft, "structure")).toBe(draft);
  });

  it("does not read an absent published namespace as an empty statement", () => {
    // A first publish of one half must not reset the other to nothing: what the draft carries is what
    // the Area is running on, inherited from the code-owned preset.
    const withoutPreset = buildAreaTree({ preset: undefined });
    const structureDraft = buildAreaTree({
      preset: { config: { modules: { runtimeModules: ["@phis/ui/modules/avatar"] } } },
    });
    const moduleDraft = buildAreaTree({
      preset: { config: { shell: { rootRoute: { mode: "landing" } } } },
    });

    expect(
      configOf(mergePhiAreaTreeForPublish(withoutPreset, structureDraft, "structure")).modules,
    ).toEqual({ runtimeModules: ["@phis/ui/modules/avatar"] });
    expect(
      configOf(mergePhiAreaTreeForPublish(withoutPreset, moduleDraft, "modules")).shell,
    ).toEqual({ rootRoute: { mode: "landing" } });
  });

  it("drops the owned namespace when the publishing draft states nothing about it", () => {
    const draft = buildAreaTree({ preset: { config: {} } });

    const merged = mergePhiAreaTreeForPublish(publishedTree, draft, "modules");

    expect(configOf(merged)).not.toHaveProperty("modules");
    expect(configOf(merged).shell).toEqual({ rootRoute: { mode: "redirect" } });
  });

  it("carries over a key nobody owns rather than losing stored data", () => {
    const publishedWithStray = buildAreaTree({
      preset: { config: { ...configOf(publishedTree), legacy: { kept: true } } },
    });
    const draft = buildAreaTree({
      preset: { config: { modules: { runtimeModules: [] } } },
    });

    expect(
      configOf(mergePhiAreaTreeForPublish(publishedWithStray, draft, "modules")).legacy,
    ).toEqual({ kept: true });
  });
});
