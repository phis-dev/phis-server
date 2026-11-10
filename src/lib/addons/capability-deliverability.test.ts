import { describe, expect, it, vi } from "vitest";

// Building a capability binds it to the pool without querying it; a test that builds them needs no database.
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getPool: () => ({}),
}));

import { PHIS_CORE_CAPABILITIES } from "@phis/contracts/addon";
import { buildPhisAddonCapabilities } from "./capabilities.ts";
import { isPhisAddonCapabilityDeliverable } from "./core-capabilities.ts";

/**
 * The gate that admits an Add-on has to ask what Core can hand over, not what Core can name.
 *
 * The catalogue in `@phis/contracts` is a vocabulary and reserves names before anything builds them.
 * Asking it let an Add-on requiring a reserved name pass the dispatcher, the job runner and the service
 * factory, and then find `undefined` where its capability should have been. That is the failure
 * `PhisAddonCapabilities` promises does not happen.
 *
 * Which names those are moves as Core builds them -- `resource-links:v1` was the original example, then
 * `support:v1`, and both are deliverable now -- so the two lists are asserted against each other rather
 * than written out here.
 */
describe("core capability deliverability", () => {
  const manifestRequiring = (ids: string[]) => ({
    addonId: "@probe/gate",
    requiredCoreCapabilities: ids,
    roles: [],
  }) as never;

  it("separates naming a capability from offering it", () => {
    expect(isPhisAddonCapabilityDeliverable(PHIS_CORE_CAPABILITIES.threads)).toBe(true);
    expect(isPhisAddonCapabilityDeliverable(PHIS_CORE_CAPABILITIES.resourceLinks)).toBe(true);
    expect(isPhisAddonCapabilityDeliverable(PHIS_CORE_CAPABILITIES.support)).toBe(true);
    /*
     * Named and reserved, handed to nobody: the case this gate exists for. A Site Module asks whether
     * this server performs authentication and is told yes; an Add-on asking to be handed an object
     * about it is stopped here, because there is no object.
     */
    expect(isPhisAddonCapabilityDeliverable(PHIS_CORE_CAPABILITIES.authentication)).toBe(false);
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
        paymentHook: { method: "POST", headers: {}, body: new Uint8Array() },
      });
      expect(
        (capabilities as Record<string, unknown>)[field],
        `${id} is gated as deliverable but no field was built for it`,
      ).toBeDefined();
    }
  });

  it("binds Payment notifications only to an original hook and keeps the consumer surface narrow", () => {
    const capabilities = buildPhisAddonCapabilities({ manifest: manifestRequiring([PHIS_CORE_CAPABILITIES.payments, PHIS_CORE_CAPABILITIES.paymentNotifications]),
      manifestDigest: "probe", siteId: 1, siteKey: "probe-site", actorUserId: null });
    expect(capabilities.paymentNotifications).toBeUndefined();
    expect(Object.keys(capabilities.payments!).sort()).toEqual(["listMethods", "create", "get", "getOperation", "getRefund", "complete", "refresh", "capture", "cancel", "refund",
      "getStoredMethod", "listStoredMethods", "removeStoredMethod", "createSubscription", "getSubscription", "listSubscriptionPeriods",
      "cancelSubscription", "resumeSubscription", "settleSubscription", "replaceSubscriptionMethod",
      "setupMethod", "refreshStoredMethod", "changeSubscriptionPrice"].sort());
    expect(isPhisAddonCapabilityDeliverable(PHIS_CORE_CAPABILITIES.payments)).toBe(true);
    expect(isPhisAddonCapabilityDeliverable(PHIS_CORE_CAPABILITIES.paymentNotifications)).toBe(true);
  });

  it("builds nothing for a capability it declares undeliverable", () => {
    const capabilities = buildPhisAddonCapabilities({
      manifest: manifestRequiring([PHIS_CORE_CAPABILITIES.authentication]),
      manifestDigest: "probe",
      siteId: 1,
      siteKey: "probe-site",
      actorUserId: 7,
    });
    expect(Object.keys(capabilities)).toEqual([]);
  });
});
