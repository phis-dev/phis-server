import { describe, expect, it } from "vitest";

import {
  PHI_FIRST_PARTY_AUTH_UI_MODULE_ID,
  restoreFirstPartyAuthInAreaTree,
} from "./auth-preset.mts";

const OTHER_PROVIDER = "@acme/login";

/** The Module selection lives under `config.modules`; the helper keeps the tests reading about it. */
function areaTree(modules: Record<string, unknown>, config: Record<string, unknown> = {}) {
  return { regions: ["kept"], preset: { flags: 0, config: { ...config, modules } } };
}

function readModulesConfig(tree: Record<string, unknown>) {
  const preset = tree.preset as Record<string, unknown>;
  const config = preset.config as Record<string, unknown>;
  return config.modules as Record<string, unknown>;
}

describe("restoreFirstPartyAuthInAreaTree", () => {
  it("activates the first-party provider when the Area has none", () => {
    const result = restoreFirstPartyAuthInAreaTree(
      areaTree({ runtimeModules: ["@phis/ui/modules/asset"] }),
    );

    expect(result.activated).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.runtimeModules).toEqual([
      PHI_FIRST_PARTY_AUTH_UI_MODULE_ID,
      "@phis/ui/modules/asset",
    ]);
    expect(result.removedProviderModuleIds).toEqual([]);
  });

  it("deactivates a conflicting provider and names it", () => {
    const result = restoreFirstPartyAuthInAreaTree(
      areaTree({
        runtimeModules: ["@phis/ui/modules/asset", OTHER_PROVIDER],
        authUiProviderModuleId: OTHER_PROVIDER,
      }),
    );

    expect(result.removedProviderModuleIds).toEqual([OTHER_PROVIDER]);
    expect(result.runtimeModules).toEqual([
      PHI_FIRST_PARTY_AUTH_UI_MODULE_ID,
      "@phis/ui/modules/asset",
    ]);
    expect(readModulesConfig(result.tree).authUiProviderModuleId).toBe(
      PHI_FIRST_PARTY_AUTH_UI_MODULE_ID,
    );
  });

  it("reports no change when the effective preset already matches", () => {
    const result = restoreFirstPartyAuthInAreaTree(
      areaTree({
        runtimeModules: [PHI_FIRST_PARTY_AUTH_UI_MODULE_ID, "@phis/ui/modules/asset"],
        authUiProviderModuleId: PHI_FIRST_PARTY_AUTH_UI_MODULE_ID,
      }),
    );

    expect(result.activated).toBe(false);
    expect(result.changed).toBe(false);
  });

  it("leaves an unrelated selection order alone", () => {
    const runtimeModules = [
      "@phis/ui/modules/asset",
      "@phis/ui/modules/groups",
      PHI_FIRST_PARTY_AUTH_UI_MODULE_ID,
    ];
    const result = restoreFirstPartyAuthInAreaTree(
      areaTree({ runtimeModules, authUiProviderModuleId: PHI_FIRST_PARTY_AUTH_UI_MODULE_ID }),
    );

    expect(result.changed).toBe(false);
    expect(result.runtimeModules).toEqual(runtimeModules);
  });

  it("keeps everything it was not asked to touch", () => {
    const result = restoreFirstPartyAuthInAreaTree({
      ...areaTree(
        { runtimeModules: [], mediaSpaces: { user: { kinds: ["image"] } } },
        { shell: { rootRoute: { mode: "landing" } } },
      ),
      overlays: ["kept"],
    });

    expect((result.tree as Record<string, unknown>).overlays).toEqual(["kept"]);
    expect((result.tree as Record<string, unknown>).regions).toEqual(["kept"]);
    expect(readModulesConfig(result.tree).mediaSpaces).toEqual({ user: { kinds: ["image"] } });
    // The Shell namespace belongs to another workspace and is not this operation's to rewrite.
    const config = (result.tree.preset as Record<string, unknown>).config as Record<string, unknown>;
    expect(config.shell).toEqual({ rootRoute: { mode: "landing" } });
  });

  it("stays put when its own output is fed back in", () => {
    const first = restoreFirstPartyAuthInAreaTree({ preset: { config: {} } });
    const second = restoreFirstPartyAuthInAreaTree(first.tree);

    expect(second.runtimeModules).toEqual([PHI_FIRST_PARTY_AUTH_UI_MODULE_ID]);
    expect(second.activated).toBe(false);
    expect(second.changed).toBe(false);
    expect(second.removedProviderModuleIds).toEqual([]);
  });

  it("treats a tree without a preset as an empty selection", () => {
    const result = restoreFirstPartyAuthInAreaTree({});

    expect(result.activated).toBe(true);
    expect(result.runtimeModules).toEqual([PHI_FIRST_PARTY_AUTH_UI_MODULE_ID]);
  });
});
