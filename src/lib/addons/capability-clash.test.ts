import { describe, expect, it } from "vitest";

import { findPhisAddonCapabilityClashes, PHIS_CORE_CAPABILITIES } from "./core-capabilities";

/**
 * A capability has one supplier. Before this was asked at install, the clash surfaced in reconcile as a
 * unique-constraint violation that stopped every Add-on's reconcile, not only the one that caused it.
 */
describe("capability suppliers of an Add-on artifact", () => {
  const installed = [{ addonId: "@acme/mail", manifest: { capabilities: [{ id: "mail-relay:v1" }] } }];

  it("names the Add-on already supplying a declared capability", () => {
    expect(findPhisAddonCapabilityClashes([{ id: "mail-relay:v1" }, { id: "fax:v1" }], installed))
      .toEqual([{ capabilityId: "mail-relay:v1", supplier: "@acme/mail" }]);
  });

  it("counts Core as a supplier", () => {
    const coreId = PHIS_CORE_CAPABILITIES[0]!.id;
    expect(findPhisAddonCapabilityClashes([{ id: coreId }], []))
      .toEqual([{ capabilityId: coreId, supplier: "@phis/server/core" }]);
  });

  it("finds nothing for capabilities nobody supplies yet", () => {
    expect(findPhisAddonCapabilityClashes([{ id: "fax:v1" }], installed)).toEqual([]);
  });
});
