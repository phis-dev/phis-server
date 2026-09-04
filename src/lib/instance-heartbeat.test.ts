import { hostname } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPhisInstanceReport } from "./instance-heartbeat";
import { PHIS_INSTANCE_ID_ENV } from "@/lib/instance-identity.mts";
import { getPhisAddonInstalledManifest } from "@/lib/addons/installed";
import { isPhiSecretStoreReadable } from "@/lib/secrets/resolver";

vi.mock("@/lib/config-files", () => ({
  getDefaultServerPhiRoot: () => "/srv/phis/stages/prod",
}));
vi.mock("@/lib/addons/installed", () => ({
  getPhisAddonInstalledManifest: vi.fn(() => ({})),
  getPhisAddonBuildDigest: vi.fn(() => "a".repeat(64)),
}));
vi.mock("@/lib/secrets/resolver", () => ({
  isPhiSecretStoreReadable: vi.fn(() => true),
}));
vi.mock("@/lib/db", () => ({ getPool: vi.fn() }));
vi.mock("@/db/server-instances.mts", () => ({
  recordPhisServerInstance: vi.fn(),
}));

const env = process.env as Record<string, string | undefined>;
const originalInstanceId = env[PHIS_INSTANCE_ID_ENV];
const originalRelease = env.PHIS_RELEASE_ID;

beforeEach(() => {
  delete env[PHIS_INSTANCE_ID_ENV];
  env.PHIS_RELEASE_ID = "0.1.0";
});

afterEach(() => {
  if (originalInstanceId === undefined) {
    delete env[PHIS_INSTANCE_ID_ENV];
  } else {
    env[PHIS_INSTANCE_ID_ENV] = originalInstanceId;
  }
  if (originalRelease === undefined) {
    delete env.PHIS_RELEASE_ID;
  } else {
    env.PHIS_RELEASE_ID = originalRelease;
  }
});

describe("buildPhisInstanceReport", () => {
  it("names the host and the stage, which is what distinguishes two instances", () => {
    expect(buildPhisInstanceReport().instanceId).toBe(
      `${hostname()}:/srv/phis/stages/prod`,
    );
  });

  it("takes the override, for a host whose name is regenerated on every start", () => {
    env[PHIS_INSTANCE_ID_ENV] = "prod-a";
    expect(buildPhisInstanceReport().instanceId).toBe("prod-a");
  });

  it("ignores an override that is only whitespace", () => {
    env[PHIS_INSTANCE_ID_ENV] = "   ";
    expect(buildPhisInstanceReport().instanceId).toBe(`${hostname()}:/srv/phis/stages/prod`);
  });

  it("carries the Core capabilities even with no Add-on installed", () => {
    const report = buildPhisInstanceReport();
    expect(report.addonPackages).toEqual({});
    expect(Object.keys(report.capabilityDigests).length).toBeGreaterThan(0);
    expect(report.releaseBuildId).toBe("0.1.0");
    expect(report.addonManifestDigest).toBe("a".repeat(64));
  });

  it("reports the version on disk and the capabilities that version declares", () => {
    vi.mocked(getPhisAddonInstalledManifest).mockReturnValue({
      "@acme/status": {
        enabled: true,
        manifestDigest: "b".repeat(64),
        manifest: {
          packageVersion: "2.1.0",
          capabilities: [{ id: "@acme/status:v1", interfaceDigest: "c".repeat(64) }],
        },
        load: vi.fn(),
      },
    } as unknown as ReturnType<typeof getPhisAddonInstalledManifest>);

    const report = buildPhisInstanceReport();
    expect(report.addonPackages).toEqual({ "@acme/status": "2.1.0" });
    expect(report.capabilityDigests["@acme/status:v1"]).toBe("c".repeat(64));
  });

  it("is not ready without its root key, because it could answer no request that needs one", () => {
    vi.mocked(isPhiSecretStoreReadable).mockReturnValue(false);
    expect(buildPhisInstanceReport().ready).toBe(false);
  });

  it("says the release is unknown rather than empty when the build stamped none", () => {
    delete env.PHIS_RELEASE_ID;
    expect(buildPhisInstanceReport().releaseBuildId).toBe("unknown");
  });
});
