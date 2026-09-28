import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ registry: vi.fn(), enabled: vi.fn() }));
vi.mock("@/db/server-addons", () => ({
  getPhisAddonRegistryRecord: mocks.registry,
  isPhisAddonEnabledForSite: mocks.enabled,
}));

import { verifyPhisAddonRegistryState } from "./registry-state";

const entry = {
  manifestDigest: "digest",
  manifest: {
    addonId: "acme.shop", packageName: "@acme/shop", packageVersion: "1.2.0",
    serverAbi: 1, migrationVersion: 4,
  },
} as never;

const row = {
  globallyEnabled: true, packageName: "@acme/shop", packageVersion: "1.2.0",
  serverAbi: 1, manifestDigest: "digest", migrationVersion: 4,
};

describe("whether an Add-on build may run", () => {
  beforeEach(() => {
    mocks.registry.mockReset().mockResolvedValue(row);
    mocks.enabled.mockReset().mockResolvedValue(true);
  });

  it("is ready where registry and build agree and the Site has it on", async () => {
    expect(await verifyPhisAddonRegistryState(entry, 7)).toBe("ready");
  });

  it("is unavailable while the registry's migrations are behind the build", async () => {
    mocks.registry.mockResolvedValue({ ...row, migrationVersion: 3 });
    expect(await verifyPhisAddonRegistryState(entry, 7)).toBe("unavailable");
  });

  it("is unavailable for another build or no registry row at all", async () => {
    mocks.registry.mockResolvedValue({ ...row, manifestDigest: "other" });
    expect(await verifyPhisAddonRegistryState(entry, 7)).toBe("unavailable");
    mocks.registry.mockResolvedValue(null);
    expect(await verifyPhisAddonRegistryState(entry, 7)).toBe("unavailable");
  });

  it("is hidden where it is switched off, globally or for the Site", async () => {
    mocks.enabled.mockResolvedValue(false);
    expect(await verifyPhisAddonRegistryState(entry, 7)).toBe("hidden");
    mocks.registry.mockResolvedValue({ ...row, globallyEnabled: false });
    expect(await verifyPhisAddonRegistryState(entry, null)).toBe("hidden");
  });
});
