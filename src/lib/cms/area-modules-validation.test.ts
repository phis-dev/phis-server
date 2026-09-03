import { describe, expect, it } from "vitest";

import { validateCmsAreaModulesWriteInput } from "./write-validation";

/*
 * What the Module write accepts, and what it must not.
 *
 * The route exists so a Module selection can be saved without sending an Area, so the interesting
 * cases are the ones where a caller sends something else: a structure payload, a config that is not
 * one, or a baseline for a different Area than the one it claims to describe.
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
      runtimeModules: ["@phis/ui/modules/avatar", "@acme/status/modules/status"],
      authUiProviderModuleId: null,
      mediaSpaces: { user: { kinds: ["image"] } },
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
      expect(result.value.config.runtimeModules).toEqual([
        "@phis/ui/modules/avatar",
        "@acme/status/modules/status",
      ]);
    }
  });

  it("accepts an empty selection, which is not the same as an absent one", () => {
    const payload = buildModulesPayload();
    payload.config.runtimeModules = [];

    expect(validateCmsAreaModulesWriteInput(payload).ok).toBe(true);
  });

  it("rejects a config without a module list", () => {
    const payload = buildModulesPayload() as { config: Record<string, unknown> };
    delete payload.config.runtimeModules;

    const result = validateCmsAreaModulesWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("config.runtimeModules must be an array of module ids.");
    }
  });

  it("rejects module ids that are not ids", () => {
    const payload = buildModulesPayload() as unknown as { config: { runtimeModules: unknown[] } };
    payload.config.runtimeModules = ["@phis/ui/modules/avatar", 7];

    const result = validateCmsAreaModulesWriteInput(payload);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toContain("config.runtimeModules must be an array of module ids.");
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
