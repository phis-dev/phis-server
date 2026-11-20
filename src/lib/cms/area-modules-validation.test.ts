import { describe, expect, it } from "vitest";

import {
  validateCmsAreaModulesRevisionTree,
  validateCmsAreaModulesWriteInput,
} from "./write-validation";

/*
 * What the Module write accepts, and what it must not.
 *
 * The route exists so a Module selection can be saved without sending an Area, so the interesting
 * cases are the ones where a caller sends something else: a structure payload, a config that is not
 * one, a namespace belonging to the other draft, or the shell identity and baseline the selection
 * carried while it lived inside the structure tree.
 */

function buildModulesPayload() {
  return {
    area: "app",
    config: {
      modules: {
        runtimeModules: ["@phis/ui/modules/avatar", "@acme/status/modules/status"],
        authUiProviderModuleId: null,
        mediaSpaces: { user: { kinds: ["image"] } },
      },
    },
  };
}

describe("validateCmsAreaModulesWriteInput", () => {
  it("accepts a selection and derives the Area mask", () => {
    const result = validateCmsAreaModulesWriteInput(buildModulesPayload());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.area).toBe("app");
      expect(result.value.areaMask).toBeGreaterThan(0);
      expect(result.value.config).toEqual({
        modules: {
          runtimeModules: ["@phis/ui/modules/avatar", "@acme/status/modules/status"],
          authUiProviderModuleId: null,
          mediaSpaces: { user: { kinds: ["image"] } },
        },
      });
    }
  });

  it("accepts an empty selection, which is not the same as an absent one", () => {
    const payload = buildModulesPayload();
    payload.config.modules.runtimeModules = [];

    expect(validateCmsAreaModulesWriteInput(payload).ok).toBe(true);
  });

  it("rejects a config that states nothing about the Module namespace", () => {
    const payload = buildModulesPayload() as { config: Record<string, unknown> };
    delete payload.config.modules;

    const result = validateCmsAreaModulesWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("config.modules must be provided as an object.");
    }
  });

  it("rejects a config without a module list", () => {
    const payload = buildModulesPayload() as unknown as { config: { modules: Record<string, unknown> } };
    delete payload.config.modules.runtimeModules;

    const result = validateCmsAreaModulesWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("config.modules.runtimeModules must be an array of module ids.");
    }
  });

  it("rejects module ids that are not ids", () => {
    const payload = buildModulesPayload() as unknown as { config: { modules: { runtimeModules: unknown[] } } };
    payload.config.modules.runtimeModules = ["@phis/ui/modules/avatar", 7];

    const result = validateCmsAreaModulesWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("config.modules.runtimeModules must be an array of module ids.");
    }
  });

  it("refuses the Shell namespace, which belongs to the structure draft", () => {
    const payload = buildModulesPayload() as unknown as { config: Record<string, unknown> };
    payload.config.shell = { rootRoute: { mode: "landing" } };

    const result = validateCmsAreaModulesWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain(
        "config.shell belongs to the other draft and must not be written here.",
      );
    }
  });

  it("refuses a namespace nobody owns, rather than storing what nothing reads back", () => {
    const payload = buildModulesPayload() as unknown as { config: Record<string, unknown> };
    payload.config.whatever = { some: "value" };

    const result = validateCmsAreaModulesWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("config.whatever is not a known Area config namespace.");
    }
  });

  it("refuses structure sent alongside it rather than storing or dropping it", () => {
    const result = validateCmsAreaModulesWriteInput({
      ...buildModulesPayload(),
      regions: [{ regionType: 1, rootLayoutNodeId: "whatever" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("regions is not part of an Area Module write.");
    }
  });

  it("refuses the shell identity and the baseline, which a selection no longer carries", () => {
    const result = validateCmsAreaModulesWriteInput({
      ...buildModulesPayload(),
      sourcePreset: { ownerModuleId: "@phis/ui", presetKey: "app-area-preset", sourcePresetVersion: 1 },
      baseline: { area: "app" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toEqual([
        "sourcePreset is not part of an Area Module write.",
        "baseline is not part of an Area Module write.",
      ]);
    }
  });

  it("rejects a body that is not an object", () => {
    expect(validateCmsAreaModulesWriteInput("modules").ok).toBe(false);
  });
});

describe("validateCmsAreaModulesRevisionTree", () => {
  const tree = {
    area: "app",
    preset: { config: { modules: { runtimeModules: ["@phis/ui/modules/avatar"] } } },
  };

  it("reads a Modules revision back as the config its write carried", () => {
    const result = validateCmsAreaModulesRevisionTree(tree);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.area).toBe("app");
      expect(result.value.config).toEqual({ modules: { runtimeModules: ["@phis/ui/modules/avatar"] } });
    }
  });

  it("refuses a structure, which is not a Modules revision", () => {
    const result = validateCmsAreaModulesRevisionTree({
      ...tree,
      sourcePreset: { ownerModuleId: "@phis/ui", presetKey: "app-area-preset", sourcePresetVersion: 1 },
      regions: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toEqual([
        "sourcePreset is not part of an Area Modules revision.",
        "regions is not part of an Area Modules revision.",
      ]);
    }
  });

  it("refuses anything in the preset but its config, and the Shell's namespace in that config", () => {
    const result = validateCmsAreaModulesRevisionTree({
      area: "app",
      preset: { flags: 0, config: { shell: {}, modules: { runtimeModules: [] } } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toEqual([
        "preset.flags is not part of an Area Modules revision.",
        "preset.config.shell belongs to the other draft and must not be written here.",
      ]);
    }
  });

  it("refuses a revision without a selection", () => {
    expect(validateCmsAreaModulesRevisionTree({ area: "app", preset: { config: {} } }).ok).toBe(false);
  });
});
