import { describe, expect, it } from "vitest";

import {
  PHIS_ADDON_ABI_VERSION,
  PHIS_ADDON_MANIFEST_VERSION,
} from "./contract";
import {
  PHIS_SERVICE_KINDS,
  isPhisServiceInterfaceCurrent,
  isPhisServiceKind,
  phisServiceInterfaceDigest,
} from "./core-services";
import { validatePhisAddonManifest } from "./manifest";

const storageDigest = phisServiceInterfaceDigest(PHIS_SERVICE_KINDS.mediaStorage);

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: PHIS_ADDON_MANIFEST_VERSION,
    addonId: "@phis/storage-s3",
    packageName: "@phis/storage-s3",
    packageVersion: "0.1.0",
    serverAbi: `^${PHIS_ADDON_ABI_VERSION}`,
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: [],
    apiRoutes: [],
    hooks: [],
    jobs: [],
    schema: null,
    queries: null,
    settings: [],
    migrationVersion: 0,
    ...overrides,
  };
}

const serviceProvider = (overrides: Record<string, unknown> = {}) => ({
  serviceKind: PHIS_SERVICE_KINDS.mediaStorage,
  providerKey: "@phis/storage-s3/s3",
  interfaceDigest: storageDigest,
  factoryExport: "createS3MediaStorageAdapter",
  requiredCoreCapabilities: [],
  ...overrides,
});

describe("service kinds", () => {
  it("names only kinds Core actually owns", () => {
    expect(isPhisServiceKind(PHIS_SERVICE_KINDS.mediaStorage)).toBe(true);
    expect(isPhisServiceKind("@phis/server/service/whatever")).toBe(false);
    expect(isPhisServiceKind(undefined)).toBe(false);
  });

  it("gives each kind its own interface digest", () => {
    expect(phisServiceInterfaceDigest(PHIS_SERVICE_KINDS.mediaStorage))
      .not.toBe(phisServiceInterfaceDigest(PHIS_SERVICE_KINDS.directory));
    expect(storageDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses a digest from a different interface", () => {
    expect(isPhisServiceInterfaceCurrent(PHIS_SERVICE_KINDS.mediaStorage, storageDigest))
      .toBe(true);
    expect(isPhisServiceInterfaceCurrent(
      PHIS_SERVICE_KINDS.mediaStorage,
      phisServiceInterfaceDigest(PHIS_SERVICE_KINDS.directory),
    )).toBe(false);
  });
});

describe("service provider descriptors", () => {
  it("accepts a well-formed declaration", () => {
    const result = validatePhisAddonManifest(
      manifest({ serviceProviders: [serviceProvider()] }),
    );
    expect(result.issues).toEqual([]);
    expect(result.manifest).not.toBeNull();
  });

  it("refuses a service kind Core does not own", () => {
    const result = validatePhisAddonManifest(
      manifest({ serviceProviders: [serviceProvider({ serviceKind: "@acme/service/queue" })] }),
    );
    expect(result.issues.join(" ")).toMatch(/is not a Core service kind/u);
  });

  it("refuses an Add-on built against a different interface", () => {
    const result = validatePhisAddonManifest(
      manifest({ serviceProviders: [serviceProvider({ interfaceDigest: "0".repeat(64) })] }),
    );
    expect(result.issues.join(" ")).toMatch(/does not match the .* interface this release offers/u);
  });

  it("refuses the same kind and key twice", () => {
    const result = validatePhisAddonManifest(
      manifest({ serviceProviders: [serviceProvider(), serviceProvider()] }),
    );
    expect(result.issues.join(" ")).toMatch(/serviceProviders/u);
  });

  it("lets one Add-on implement two different kinds", () => {
    const result = validatePhisAddonManifest(manifest({
      serviceProviders: [
        serviceProvider(),
        serviceProvider({
          serviceKind: PHIS_SERVICE_KINDS.directory,
          providerKey: "@phis/storage-s3/ldap",
          interfaceDigest: phisServiceInterfaceDigest(PHIS_SERVICE_KINDS.directory),
          factoryExport: "createLdapDirectoryAdapter",
        }),
      ],
    }));
    expect(result.issues).toEqual([]);
  });

  it("requires the field to be present at all", () => {
    const withoutField = manifest();
    delete (withoutField as Record<string, unknown>).serviceProviders;
    expect(validatePhisAddonManifest(withoutField).issues.join(" "))
      .toMatch(/serviceProviders must be an array/u);
  });

  it("requires the provider key to be qualified by the Add-on that declares it", () => {
    const result = validatePhisAddonManifest(
      manifest({ serviceProviders: [serviceProvider({ providerKey: "@acme/other/s3" })] }),
    );
    expect(result.issues.join(" ")).toMatch(/must start with "@phis\/storage-s3\/"/u);
  });

  it("refuses a factory export name that is not an identifier", () => {
    const result = validatePhisAddonManifest(
      manifest({ serviceProviders: [serviceProvider({ factoryExport: "not a name" })] }),
    );
    expect(result.issues.join(" ")).toMatch(/factoryExport is invalid/u);
  });

  it("keeps the descriptor inside the manifest digest", async () => {
    const { digestPhisAddonManifest } = await import("./manifest");
    const withProvider = validatePhisAddonManifest(
      manifest({ serviceProviders: [serviceProvider()] }),
    ).manifest!;
    const withoutProvider = validatePhisAddonManifest(manifest()).manifest!;

    // The digest exists so a build cannot quietly gain or lose a service implementation.
    expect(digestPhisAddonManifest(withProvider))
      .not.toBe(digestPhisAddonManifest(withoutProvider));
  });
});
