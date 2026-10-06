import { describe, expect, it } from "vitest";

import { validateCmsAreaModulesWriteInput } from "./write-validation";

/*
 * What the Module write accepts, and what it must not.
 *
 * The route exists so a Module selection can be saved without sending an Area, so the interesting
 * cases are the ones where a caller sends something else: a structure payload, a config that is not
 * one, a namespace belonging to the other draft, or a baseline for a different Area than it claims.
 */

function buildModulesPayload() {
  return {
    area: "app",
    sourcePreset: {
      ownerModuleId: "@phis/ui",
      presetKey: "app-area-preset",
      sourcePresetVersion: 1,
    },
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

  it("ignores structure sent alongside it rather than storing it", () => {
    const result = validateCmsAreaModulesWriteInput({
      ...buildModulesPayload(),
      regions: [{ regionType: 1, rootLayoutNodeId: "whatever" }],
      contentWidgets: [{ id: "whatever" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty("regions");
      expect(result.value).not.toHaveProperty("contentWidgets");
    }
  });

  it("rejects a baseline that describes a different Area", () => {
    const result = validateCmsAreaModulesWriteInput({
      ...buildModulesPayload(),
      baseline: {
        area: "admin",
        sourcePreset: {
          ownerModuleId: "@phis/ui",
          presetKey: "admin-area-preset",
          sourcePresetVersion: 1,
        },
        regions: [],
        overlays: [],
        layoutNodes: [],
        contentWidgets: [],
        controllerSettings: [],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("baseline must describe the same Area.");
    }
  });

  it("rejects a body that is not an object", () => {
    expect(validateCmsAreaModulesWriteInput("modules").ok).toBe(false);
  });
});
