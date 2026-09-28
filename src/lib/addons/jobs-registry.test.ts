import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ state: vi.fn(), deliver: vi.fn(), build: vi.fn() }));
const entry = {
  enabled: true,
  manifestDigest: "digest",
  manifest: {
    addonId: "acme.shop",
    requiredCoreCapabilities: [],
    jobs: [{ id: "sync", handler: "sync" }],
  },
};
vi.mock("./installed.ts", () => ({ getPhisAddonInstalledManifest: () => ({ "acme.shop": entry }) }));
vi.mock("./manifest.ts", () => ({
  validatePhisAddonManifest: () => ({ manifest: entry.manifest }),
  digestPhisAddonManifest: () => "digest",
}));
vi.mock("./core-capabilities.ts", () => ({ isPhisAddonCapabilityDeliverable: () => true }));
vi.mock("./event-delivery.ts", () => ({ deliverPhisAddonEvents: mocks.deliver }));
vi.mock("./capabilities.ts", () => ({ buildPhisAddonCapabilities: mocks.build }));
vi.mock("./registry-state.ts", () => ({ verifyPhisAddonRegistryState: mocks.state }));

import { PhisAddonJobError, runPhisAddonJob } from "./jobs";

/**
 * A job is code of the Add-on's running against the Add-on's tables. Between `addon upgrade` and
 * `addon migrate` the code is new and the tables are not; the job has to be refused there, as a
 * request would be.
 */
describe("a job whose build the registry does not describe", () => {
  it("is refused before anything of the Add-on's runs", async () => {
    mocks.state.mockResolvedValue("unavailable");

    await expect(runPhisAddonJob({ addonId: "acme.shop", jobId: "sync", site: { id: 7, key: "site" } }))
      .rejects.toThrow(PhisAddonJobError);
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("is refused as switched off where the Site does not have it", async () => {
    mocks.state.mockResolvedValue("hidden");
    await expect(runPhisAddonJob({ addonId: "acme.shop", jobId: "sync", site: { id: 7, key: "site" } }))
      .rejects.toThrow(/not enabled for site/);
  });
});
