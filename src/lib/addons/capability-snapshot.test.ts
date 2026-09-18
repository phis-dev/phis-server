import { describe, expect, it } from "vitest";

import { PHIS_CORE_CAPABILITIES } from "@phis/contracts/addon";
import { createPhisCoreCapabilityProvider } from "./capability-snapshot.ts";
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
