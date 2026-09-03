import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PHIS_SERVICE_INTERFACE_DIGESTS,
  PHIS_SERVICE_INTERFACE_VERSIONS,
  PHIS_SERVICE_KINDS,
} from "./contract.ts";
import {
  isPhisServiceInterfaceCurrent,
  isPhisServiceKind,
  phisServiceInterfaceDigest,
} from "./core-services.ts";

/**
 * The digests in the contract are stated, not computed, so that reading a manifest needs no hashing.
 * Stated values go stale silently, which is the whole reason this test exists: whoever raises an
 * interface version and forgets to replace the digest finds out here rather than shipping an Add-on
 * gate that lets an incompatible build through.
 */
describe("Core service interface digests", () => {
  it("match the recipe the contract documents", () => {
    for (const kind of Object.values(PHIS_SERVICE_KINDS)) {
      const version = PHIS_SERVICE_INTERFACE_VERSIONS[kind];
      const expected = createHash("sha256")
        .update(`phi-server-service-kind:${kind}:v${version}`)
        .digest("hex");
      expect(PHIS_SERVICE_INTERFACE_DIGESTS[kind]).toBe(expected);
    }
  });

  it("cover every kind, with no leftovers", () => {
    const kinds = Object.values(PHIS_SERVICE_KINDS).sort();
    expect(Object.keys(PHIS_SERVICE_INTERFACE_DIGESTS).sort()).toEqual(kinds);
    expect(Object.keys(PHIS_SERVICE_INTERFACE_VERSIONS).sort()).toEqual(kinds);
  });

  it("refuse a kind Core does not own, and a digest from another interface", () => {
    expect(isPhisServiceKind("@phis/server/service/nothing")).toBe(false);
    expect(
      isPhisServiceInterfaceCurrent(
        PHIS_SERVICE_KINDS.mediaStorage,
        phisServiceInterfaceDigest(PHIS_SERVICE_KINDS.directory),
      ),
    ).toBe(false);
    expect(
      isPhisServiceInterfaceCurrent(
        PHIS_SERVICE_KINDS.mediaStorage,
        phisServiceInterfaceDigest(PHIS_SERVICE_KINDS.mediaStorage),
      ),
    ).toBe(true);
  });
});
