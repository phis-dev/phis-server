import { describe, expect, it } from "vitest";

import { PHIS_CORE_CAPABILITIES } from "@phis/contracts/addon";
import { buildPhisAddonCapabilities } from "./capabilities.ts";
import {
  hasPhisCoreCapability,
  isPhisAddonCapabilityDeliverable,
} from "./core-capabilities.ts";

/**
 * The gate that admits an Add-on has to ask what Core can hand over, not what Core can name.
 *
 * The catalogue in `@phis/contracts` is a vocabulary and reserves names before anything builds them.
 * Asking it let an Add-on requiring `resource-links:v1` -- which has no table, let alone a capability --
 * pass the dispatcher, the job runner and the service factory, and then find `undefined` where its
 * capability should have been. That is the failure `PhisAddonCapabilities` promises does not happen.
 */
describe("core capability deliverability", () => {
  const manifestRequiring = (ids: string[]) => ({
    addonId: "@probe/gate",
    requiredCoreCapabilities: ids,
    roles: [],
  }) as never;

  it("separates naming a capability from offering it", () => {
    for (const id of Object.values(PHIS_CORE_CAPABILITIES)) {
      expect(hasPhisCoreCapability(id)).toBe(true);
    }
    expect(isPhisAddonCapabilityDeliverable(PHIS_CORE_CAPABILITIES.threads)).toBe(true);
    expect(isPhisAddonCapabilityDeliverable(PHIS_CORE_CAPABILITIES.resourceLinks)).toBe(false);
    expect(isPhisAddonCapabilityDeliverable("@phis/server/not-a-capability:v1")).toBe(false);
  });

  it("builds every capability it declares deliverable", () => {
    for (const [field, id] of Object.entries(PHIS_CORE_CAPABILITIES)) {
      if (!isPhisAddonCapabilityDeliverable(id)) {
        continue;
      }
      const capabilities = buildPhisAddonCapabilities({
        manifest: manifestRequiring([id]),
        manifestDigest: "probe",
        siteId: 1,
        // Storage, assets and secrets address the Site by key and are not built without one.
        siteKey: "probe-site",
        actorUserId: 7,
      });
      expect(
        (capabilities as Record<string, unknown>)[field],
        `${id} is gated as deliverable but no field was built for it`,
      ).toBeDefined();
    }
  });

  it("builds nothing for a capability it declares undeliverable", () => {
    const capabilities = buildPhisAddonCapabilities({
      manifest: manifestRequiring([
        PHIS_CORE_CAPABILITIES.resourceLinks,
        PHIS_CORE_CAPABILITIES.support,
        PHIS_CORE_CAPABILITIES.authentication,
      ]),
      manifestDigest: "probe",
      siteId: 1,
      siteKey: "probe-site",
      actorUserId: 7,
    });
    expect(Object.keys(capabilities)).toEqual([]);
  });
});
