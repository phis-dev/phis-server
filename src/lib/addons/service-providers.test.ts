import { describe, expect, it } from "vitest";

import {
  PHI_SERVER_ADDON_ABI_VERSION,
  PHI_SERVER_ADDON_MANIFEST_VERSION,
} from "./contract";
import {
  PHI_SERVER_SERVICE_KINDS,
  isPhiServerServiceInterfaceCurrent,
  isPhiServerServiceKind,
  phiServerServiceInterfaceDigest,
} from "./core-services";
import { validatePhiServerAddonManifest } from "./manifest";

const storageDigest = phiServerServiceInterfaceDigest(PHI_SERVER_SERVICE_KINDS.mediaStorage);

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: PHI_SERVER_ADDON_MANIFEST_VERSION,
    addonId: "@phis/storage-s3",
    packageName: "@phis/storage-s3-server",
    packageVersion: "0.1.0",
    serverAbi: `^${PHI_SERVER_ADDON_ABI_VERSION}`,
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: [],
    apiRoutes: [],
    hooks: [],
    jobs: [],
    schema: null,
    migrationVersion: 0,
    ...overrides,
  };
}

const serviceProvider = (overrides: Record<string, unknown> = {}) => ({
  serviceKind: PHI_SERVER_SERVICE_KINDS.mediaStorage,
  providerKey: "@phis/storage-s3/s3",
  interfaceDigest: storageDigest,
  factoryExport: "createS3MediaStorageAdapter",
  requiredCoreCapabilities: [],
  ...overrides,
});

describe("service kinds", () => {
  it("names only kinds Core actually owns", () => {
    expect(isPhiServerServiceKind(PHI_SERVER_SERVICE_KINDS.mediaStorage)).toBe(true);
    expect(isPhiServerServiceKind("@phis/phi-server/service/whatever")).toBe(false);
    expect(isPhiServerServiceKind(undefined)).toBe(false);
  });

  it("gives each kind its own interface digest", () => {
    expect(phiServerServiceInterfaceDigest(PHI_SERVER_SERVICE_KINDS.mediaStorage))
      .not.toBe(phiServerServiceInterfaceDigest(PHI_SERVER_SERVICE_KINDS.directory));
    expect(storageDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses a digest from a different interface", () => {
    expect(isPhiServerServiceInterfaceCurrent(PHI_SERVER_SERVICE_KINDS.mediaStorage, storageDigest))
      .toBe(true);
    expect(isPhiServerServiceInterfaceCurrent(
      PHI_SERVER_SERVICE_KINDS.mediaStorage,
      phiServerServiceInterfaceDigest(PHI_SERVER_SERVICE_KINDS.directory),
    )).toBe(false);
  });
});

describe("service provider descriptors", () => {
  it("accepts a well-formed declaration", () => {
    const result = validatePhiServerAddonManifest(
      manifest({ serviceProviders: [serviceProvider()] }),
    );
    expect(result.issues).toEqual([]);
    expect(result.manifest).not.toBeNull();
  });

  it("refuses a service kind Core does not own", () => {
    const result = validatePhiServerAddonManifest(
      manifest({ serviceProviders: [serviceProvider({ serviceKind: "@acme/service/queue" })] }),
    );
    expect(result.issues.join(" ")).toMatch(/is not a Core service kind/u);
  });

  it("refuses an Add-on built against a different interface", () => {
    const result = validatePhiServerAddonManifest(
      manifest({ serviceProviders: [serviceProvider({ interfaceDigest: "0".repeat(64) })] }),
    );
    expect(result.issues.join(" ")).toMatch(/does not match the .* interface this release offers/u);
  });

  it("refuses the same kind and key twice", () => {
    const result = validatePhiServerAddonManifest(
      manifest({ serviceProviders: [serviceProvider(), serviceProvider()] }),
    );
    expect(result.issues.join(" ")).toMatch(/serviceProviders/u);
  });

  it("lets one Add-on implement two different kinds", () => {
    const result = validatePhiServerAddonManifest(manifest({
      serviceProviders: [
        serviceProvider(),
        serviceProvider({
          serviceKind: PHI_SERVER_SERVICE_KINDS.directory,
          providerKey: "@phis/storage-s3/ldap",
          interfaceDigest: phiServerServiceInterfaceDigest(PHI_SERVER_SERVICE_KINDS.directory),
          factoryExport: "createLdapDirectoryAdapter",
        }),
      ],
    }));
    expect(result.issues).toEqual([]);
  });

  it("requires the field to be present at all", () => {
    const withoutField = manifest();
    delete (withoutField as Record<string, unknown>).serviceProviders;
    expect(validatePhiServerAddonManifest(withoutField).issues.join(" "))
      .toMatch(/serviceProviders must be an array/u);
  });

  it("requires the provider key to be qualified by the Add-on that declares it", () => {
    const result = validatePhiServerAddonManifest(
      manifest({ serviceProviders: [serviceProvider({ providerKey: "@acme/other/s3" })] }),
    );
    expect(result.issues.join(" ")).toMatch(/must start with "@phis\/storage-s3\/"/u);
  });

  it("refuses a factory export name that is not an identifier", () => {
    const result = validatePhiServerAddonManifest(
      manifest({ serviceProviders: [serviceProvider({ factoryExport: "not a name" })] }),
    );
    expect(result.issues.join(" ")).toMatch(/factoryExport is invalid/u);
  });

  it("keeps the descriptor inside the manifest digest", async () => {
    const { digestPhiServerAddonManifest } = await import("./manifest");
    const withProvider = validatePhiServerAddonManifest(
      manifest({ serviceProviders: [serviceProvider()] }),
    ).manifest!;
    const withoutProvider = validatePhiServerAddonManifest(manifest()).manifest!;

    // The digest exists so a build cannot quietly gain or lose a service implementation.
    expect(digestPhiServerAddonManifest(withProvider))
      .not.toBe(digestPhiServerAddonManifest(withoutProvider));
  });
});
