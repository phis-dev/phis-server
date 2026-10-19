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
    controllerSettings: [],
  };
}

function errorsOf(shell: unknown) {
  const result = validateCmsAreaPresetWriteInput(buildStructurePayload(shell));
  return result.ok ? [] : result.details ?? [];
}

describe("reading a stored Area revision back", () => {
  /*
   * A revision on disk was written by one of the two drafts, and after a publish merge it carries both
   * namespaces. Reading one back under the write rule refused every Module draft the moment anything
   * looked at it again -- so a Module selection could be saved once and never read, published or
   * saved over, and the failure surfaced as "Invalid area revision payload".
   */
  function storedWith(config: Record<string, unknown>) {
    return validateCmsAreaPresetWriteInput(
      { ...buildStructurePayload(), preset: { config } },
      { config: "stored" },
    );
  }

  it("takes the namespace the Module draft owns", () => {
    expect(storedWith({ modules: { runtimeModules: [] } }).ok).toBe(true);
  });

  it("takes both, which is what a published revision holds", () => {
    expect(storedWith({
      shell: {},
      modules: { runtimeModules: [] },
    }).ok).toBe(true);
  });

  it("still refuses a namespace nothing can read back", () => {
    const result = storedWith({ nonsense: {} });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.details ?? [])
      .toContain("preset.config.nonsense is not a known Area config namespace.");
  });

  it("leaves a write refusing the other draft's namespace", () => {
    // The rule that keeps two open drafts from containing each other's work stays exactly as it was.
    const result = validateCmsAreaPresetWriteInput({
      ...buildStructurePayload(),
      preset: { config: { modules: { runtimeModules: [] } } },
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.details ?? [])
      .toContain("preset.config.modules belongs to the other draft and must not be written here.");
  });
});

describe("the Shell half of an Area config", () => {
  it("takes a redirect to a Page the Site authored", () => {
    const result = validateCmsAreaPresetWriteInput(
      buildStructurePayload({ rootRoute: { mode: "redirect", targetLinkTarget: { kind: "page", reference: pageReference } } }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.preset?.config).toEqual({
        shell: { rootRoute: { mode: "redirect", targetLinkTarget: { kind: "page", reference: pageReference } } },
      });
    }
  });

  it("takes a redirect to a Page a Module carries", () => {
    expect(errorsOf({ rootRoute: { mode: "redirect", targetLinkTarget: { kind: "page", reference: moduleReference } } })).toEqual([]);
  });

  it("takes a landing page that names no applicant, which the Site authors itself", () => {
    expect(errorsOf({ rootRoute: { mode: "landing" } })).toEqual([]);
  });

  it("takes a landing page that names the applicant whose Page stands at the root", () => {
    expect(errorsOf({ rootRoute: { mode: "landing", target: moduleReference } })).toEqual([]);
  });

  it("takes a structure write that states nothing about the root route", () => {
    expect(validateCmsAreaPresetWriteInput(buildStructurePayload()).ok).toBe(true);
  });

  it("refuses a landing page whose applicant is not a reference", () => {
    expect(errorsOf({ rootRoute: { mode: "landing", target: "the welcome page" } })).toEqual([
      "preset.config.shell.rootRoute.target must be a Module Page reference.",
    ]);
  });

  /*
   * Only a Module applies for the slot. A Site Page reference there would be read as no applicant at
   * all, so it is refused rather than stored as a choice nobody can see.
   */
  it("refuses a landing page whose applicant is a Page the Site authored", () => {
    expect(errorsOf({ rootRoute: { mode: "landing", target: pageReference } })).toEqual([
      "preset.config.shell.rootRoute.target must be a Module Page reference.",
    ]);
  });

  it("refuses a mode it could not act on", () => {
    expect(errorsOf({ rootRoute: { mode: "first-nav-entry" } })).toEqual([
      'preset.config.shell.rootRoute.mode must be "landing" or "redirect".',
    ]);
  });

  it("refuses a target that is a path rather than a reference", () => {
    // A path is a fact about today's routing table; the stored answer has to survive a rename.
    expect(errorsOf({ rootRoute: { mode: "redirect", targetLinkTarget: { kind: "page", reference: "/dashboard" } } }))
      .toEqual(["preset.config.shell.rootRoute.targetLinkTarget must be an internal Page target."]);
  });

  /*
   * A forward is a link target, kept where the reference index reads one (REFERENCES.md); the landing's
   * bare `target` key on a redirect would be a forward the index cannot see.
   */
  it("refuses a redirect that keeps its Page under the landing's key", () => {
    expect(errorsOf({ rootRoute: { mode: "redirect", target: pageReference } })).toEqual([
      "preset.config.shell.rootRoute.target belongs to a landing; a redirect names its Page in targetLinkTarget.",
      "preset.config.shell.rootRoute.targetLinkTarget is required.",
    ]);
  });

  it("refuses what a forward cannot carry", () => {
    expect(errorsOf({
      rootRoute: { mode: "redirect", targetLinkTarget: { kind: "page", reference: pageReference, area: "app", fragment: "top" } },
    })).toEqual([
      "preset.config.shell.rootRoute.targetLinkTarget.area is not part of a redirect target.",
      "preset.config.shell.rootRoute.targetLinkTarget.fragment is not part of a redirect target.",
    ]);
  });

  it("takes the four answers an Area gives about the head of its Pages", () => {
    expect(errorsOf({
      meta: { index: true, sitemap: false, titleTemplate: "%s | Phi", defaultTitle: "Phi" },
    })).toEqual([]);
  });

  it("takes a structure write that states nothing about the head of its Pages", () => {
    expect(errorsOf({ rootRoute: { mode: "landing" } })).toEqual([]);
  });

  it("refuses an indexing answer that is not a boolean", () => {
    expect(errorsOf({ meta: { index: "yes" } })).toEqual([
      "preset.config.shell.meta.index must be a boolean.",
    ]);
  });

  it("refuses a meta key nothing reads back", () => {
    expect(errorsOf({ meta: { canonical: "https://example.test" } })).toEqual([
      "preset.config.shell.meta.canonical is not a known area meta key.",
    ]);
  });

  it("refuses a title that is not a string", () => {
    expect(errorsOf({ meta: { defaultTitle: 7 } })).toEqual([
      "preset.config.shell.meta.defaultTitle must be a string.",
    ]);
  });

  /*
   * A template without the placeholder is not a formatting slip: it gives every Page in the Area the
   * same title, which nothing downstream can detect and no Operator would have meant.
   */
  it("refuses a title template that drops the Page's own title", () => {
    expect(errorsOf({ meta: { titleTemplate: "Phi Systems" } })).toEqual([
      'preset.config.shell.meta.titleTemplate must contain the "%s" placeholder for the Page\'s own title.',
    ]);
  });

  it("takes an emptied title template as the answer that it is", () => {
    // Cleared means "the Site's name", which the reader resolves. Only a non-empty one has to format.
    expect(errorsOf({ meta: { titleTemplate: "" } })).toEqual([]);
  });

  it("refuses a title longer than anything a head should carry", () => {
    expect(errorsOf({ meta: { defaultTitle: "x".repeat(201) } })).toEqual([
      "preset.config.shell.meta.defaultTitle must be at most 200 characters.",
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
