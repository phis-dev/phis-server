import { describe, expect, it } from "vitest";

import { createPhiPageReference } from "@/lib/internal-references";
import { validateCmsAreaPresetWriteInput } from "./write-validation";

/*
 * What the Shell may state about itself.
 *
 * `preset.config.shell` is the structure draft's half of the Area config, and the root route is the
 * first thing stored in it. The shape is checked here and the meaning deliberately is not: whether the
 * Page a root route names still exists is asked again on every request, because a Module switched off
 * months later is not a reason to have rejected the write.
 */

const pageReference = createPhiPageReference({ kind: "site", pageScopeId: 17 });
const moduleReference = createPhiPageReference({
  kind: "module",
  ownerModuleId: "@phis/ui/modules/dashboard",
  presetKey: "builder-dashboard-page",
});

function buildStructurePayload(shell?: unknown) {
  return {
    area: "builder",
    sourcePreset: {
      ownerModuleId: "@phis/ui/builder",
      presetKey: "builder-area-preset",
      sourcePresetVersion: 1,
    },
    preset: shell === undefined ? {} : { config: { shell } },
    regions: [],
    overlays: [],
    layoutNodes: [],
    contentWidgets: [],
  };
}

function errorsOf(shell: unknown) {
  const result = validateCmsAreaPresetWriteInput(buildStructurePayload(shell));
  return result.ok ? [] : result.details ?? [];
}

describe("the Shell half of an Area config", () => {
  it("takes a redirect to a Page the Site authored", () => {
    const result = validateCmsAreaPresetWriteInput(
      buildStructurePayload({ rootRoute: { mode: "redirect", target: pageReference } }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.preset?.config).toEqual({
        shell: { rootRoute: { mode: "redirect", target: pageReference } },
      });
    }
  });

  it("takes a redirect to a Page a Module carries", () => {
    expect(errorsOf({ rootRoute: { mode: "redirect", target: moduleReference } })).toEqual([]);
  });

  it("takes a landing page, which names no target", () => {
    expect(errorsOf({ rootRoute: { mode: "landing" } })).toEqual([]);
  });

  it("takes a structure write that states nothing about the root route", () => {
    expect(validateCmsAreaPresetWriteInput(buildStructurePayload()).ok).toBe(true);
  });

  it("refuses a landing page that also names a target", () => {
    // Two answers to one question: whichever the reader honoured, the other would be a silent lie.
    expect(errorsOf({ rootRoute: { mode: "landing", target: pageReference } })).toEqual([
      'preset.config.shell.rootRoute.target must be absent when the mode is "landing".',
    ]);
  });

  it("refuses a mode it could not act on", () => {
    expect(errorsOf({ rootRoute: { mode: "first-nav-entry" } })).toEqual([
      'preset.config.shell.rootRoute.mode must be "landing" or "redirect".',
    ]);
  });

  it("refuses a target that is a path rather than a reference", () => {
    // A path is a fact about today's routing table; the stored answer has to survive a rename.
    expect(errorsOf({ rootRoute: { mode: "redirect", target: "/dashboard" } })).toEqual([
      "preset.config.shell.rootRoute.target must be an internal Page reference.",
    ]);
  });

  it("refuses a key nothing reads back", () => {
    expect(errorsOf({ rootRoute: { mode: "landing" }, backdrop: "later" })).toEqual([
      "preset.config.shell.backdrop is not a known Shell config key.",
    ]);
  });

  it("still refuses the Module selection's namespace", () => {
    const result = validateCmsAreaPresetWriteInput({
      ...buildStructurePayload({ rootRoute: { mode: "landing" } }),
      preset: { config: { shell: { rootRoute: { mode: "landing" } }, modules: { runtimeModules: [] } } },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.details).toContain(
      "preset.config.modules belongs to the other draft and must not be written here.",
    );
  });
});
