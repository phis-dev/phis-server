import { describe, expect, it, vi } from "vitest";

import { PHIS_CORE_CAPABILITIES } from "@phis/contracts/addon";

const mocks = vi.hoisted(() => ({ installed: {} as Record<string, unknown>, statements: 0 }));

vi.mock("@/lib/addons/installed", () => ({
  getPhisAddonInstalledManifest: () => mocks.installed,
  getPhisAddonBuildDigest: () => "digest",
}));
vi.mock("@/db/server-addons", () => ({
  readPhisAddonCapabilityStates: async (addonIds: readonly string[]) => {
    mocks.statements += 1;
    return new Map(addonIds.map((addonId) => {
      const entry = mocks.installed[addonId] as { manifest: Record<string, unknown>; manifestDigest: string };
      return [addonId, {
        registry: {
          globallyEnabled: true,
          packageName: entry.manifest.packageName,
          packageVersion: entry.manifest.packageVersion,
          serverAbi: entry.manifest.serverAbi,
          manifestDigest: entry.manifestDigest,
          migrationVersion: entry.manifest.migrationVersion,
        },
        siteState: { requestedEnabled: true, configurationStatus: "ready", diagnosticCode: null },
      }];
    }));
  },
}));

import { buildPhisCapabilitySnapshot, createPhisCoreCapabilityProvider } from "./capability-snapshot.ts";
import { isPhisAddonCapabilityDeliverable } from "./core-capabilities.ts";

/**
 * The snapshot is read by Site Modules, and a Module asks a different question than an Add-on does.
 *
 * Trimming Core's entry to the capabilities an Add-on can be handed reads as a tightening and is a
 * shutdown: `@phis/ui/modules/auth` binds to `authentication:v1`, a name Core answers for and builds
 * nothing behind, so the Auth Module deactivated itself, `/login` stopped resolving, and every Area
 * that sends an unauthenticated visitor there sent them nowhere. The gates that admit an Add-on are
 * elsewhere and stay there -- this list is a vocabulary, not a delivery.
 */
describe("the Core provider in the capability snapshot", () => {
  it("names every capability, including one no Add-on can be handed", () => {
    const core = createPhisCoreCapabilityProvider();

    expect(core.capabilities.map((capability) => capability.id).sort()).toEqual(
      Object.values(PHIS_CORE_CAPABILITIES).sort(),
    );
    expect(isPhisAddonCapabilityDeliverable(PHIS_CORE_CAPABILITIES.authentication)).toBe(false);
  });
});

function installedAddon(addonId: string, capabilityIds: string[]) {
  return {
    enabled: true,
    manifestDigest: `${addonId}-digest`,
    manifest: {
      packageName: addonId,
      packageVersion: "1.0.0",
      serverAbi: 1,
      migrationVersion: 1,
      capabilities: capabilityIds.map((id) => ({ id, interfaceDigest: "x" })),
    },
  };
}

/**
 * A capability has one supplier. The CLI refuses an install that adds a second, but a desired state can
 * reach the server without it, so the snapshot asks again and holds every party to a clash back.
 */
describe("a capability two suppliers claim", () => {
  async function states() {
    const snapshot = await buildPhisCapabilitySnapshot(1);
    return Object.fromEntries(snapshot.providers.slice(1).map((provider) => [
      provider.providerId,
      `${provider.state}/${provider.diagnosticCode}`,
    ]));
  }

  it("holds back both Add-ons that claim it, and leaves the others alone", async () => {
    mocks.installed = {
      "@acme/mail": installedAddon("@acme/mail", ["@acme/relay:v1"]),
      "@other/mail": installedAddon("@other/mail", ["@acme/relay:v1"]),
      "@acme/fax": installedAddon("@acme/fax", ["@acme/fax:v1"]),
    };
    expect(await states()).toEqual({
      "@acme/fax": "available/null",
      "@acme/mail": "incompatible/capability_clash",
      "@other/mail": "incompatible/capability_clash",
    });
  });

  it("holds back an Add-on that claims one of Core's", async () => {
    mocks.installed = {
      "@acme/auth": installedAddon("@acme/auth", [PHIS_CORE_CAPABILITIES.authentication]),
    };
    expect(await states()).toEqual({ "@acme/auth": "incompatible/capability_clash" });
  });
});

/**
 * The snapshot is built on every authorization read, so what it costs is paid on every signed-in request.
 */
describe("what building the snapshot costs", () => {
  it("asks the database once, however many Add-ons are installed", async () => {
    mocks.installed = Object.fromEntries(
      ["@acme/a", "@acme/b", "@acme/c", "@acme/d"].map((addonId) => [addonId, installedAddon(addonId, [`${addonId}:v1`])]),
    );
    mocks.statements = 0;
    const snapshot = await buildPhisCapabilitySnapshot(1);
    expect(snapshot.providers.slice(1).every((provider) => provider.state === "available")).toBe(true);
    expect(mocks.statements).toBe(1);
  });
});
