import { describe, expect, it } from "vitest";

import type { PhisServerInstanceRecord } from "../db/server-instances.mts";
import { findPhisInstancesLackingProvider } from "./media-storage-readiness.ts";

function instance(instanceId: string, addonPackages: Record<string, string>, ready = true): PhisServerInstanceRecord {
  return {
    instanceId,
    releaseBuildId: "r1",
    addonManifestDigest: "d",
    addonPackages,
    capabilityDigests: {},
    ready,
    lastSeenAt: "2026-11-14T00:00:00Z",
    startedAt: "2026-11-14T00:00:00Z",
  };
}

describe("which serving Instances cannot open a Provider", () => {
  it("names the ready Instance that lacks the Provider's Add-on", () => {
    expect(findPhisInstancesLackingProvider([
      instance("a", { "@phis/storage-s3": "0.1.0" }),
      instance("b", {}),
    ], "@phis/storage-s3/s3")).toEqual({ serving: 2, lacking: ["b"] });
  });

  it("does not ask an Instance that is stale or draining", () => {
    expect(findPhisInstancesLackingProvider([
      instance("a", { "@phis/storage-s3": "0.1.0" }),
      instance("gone", {}, false),
    ], "@phis/storage-s3/s3")).toEqual({ serving: 1, lacking: [] });
  });

  it("matches the Add-on by its whole id, not a shared beginning", () => {
    expect(findPhisInstancesLackingProvider([instance("a", { "@phis/storage": "0.1.0" })], "@phis/storage-s3/s3"))
      .toEqual({ serving: 1, lacking: ["a"] });
  });

  it("never finds the Local Provider missing, which every Instance carries", () => {
    expect(findPhisInstancesLackingProvider([instance("a", {})], "@phis/server/storage-local"))
      .toEqual({ serving: 1, lacking: [] });
  });
});
