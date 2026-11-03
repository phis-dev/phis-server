import { describe, expect, it } from "vitest";

import { validatePhisAddonManifest } from "./manifest.ts";

/**
 * What a declared occasion has to be before Core will write it to anybody.
 *
 * The words are the one part of a mail an Add-on supplies, and the manifest is the only moment its
 * author is there: a placeholder with no parameter behind it, or a parameter no line names, would
 * otherwise be found by the first reader.
 */

function manifest(extra: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    addonId: "@acme/shop",
    packageName: "@acme/shop",
    packageVersion: "1.0.0",
    serverAbi: "^1",
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: ["@phis/server/notifications:v1"],
    apiRoutes: [],
    hooks: [],
    jobs: [],
    schema: null,
    migrationVersion: 0,
    ...extra,
  };
}

const orderPaid = {
  name: "order-paid",
  class: "asked-for",
  subject: { text: "Your order %1 is paid", parameters: ["number"] },
  lines: [
    { text: "Thank you. We have received your payment for order %1.", parameters: ["number"] },
    { text: "You can follow it here: %1", parameters: ["link"] },
  ],
  parameters: [
    { name: "number", type: "text" },
    { name: "link", type: "path" },
  ],
};

describe("occasions in a manifest", () => {
  it("admits a well-formed occasion, and a manifest that states none", () => {
    expect(validatePhisAddonManifest(manifest({ occasions: [orderPaid] })).issues).toEqual([]);
    expect(validatePhisAddonManifest(manifest()).issues).toEqual([]);
  });

  it("refuses every class but asked-for", () => {
    const { issues } = validatePhisAddonManifest(manifest({ occasions: [{ ...orderPaid, class: "sent" }] }));
    expect(issues).toContain('occasions[0].class must be "asked-for".');
  });

  it("refuses a line whose placeholders and parameters disagree", () => {
    const missing = { ...orderPaid, lines: [{ text: "Paid.", parameters: ["number"] }] };
    expect(validatePhisAddonManifest(manifest({ occasions: [missing] })).issues)
      .toContain("occasions[0].lines[0].text does not use %1.");
    const stray = { ...orderPaid, lines: [{ text: "Paid %1 and %2.", parameters: ["number"] }] };
    expect(validatePhisAddonManifest(manifest({ occasions: [stray] })).issues)
      .toContain("occasions[0].lines[0].text uses %2, which names no parameter.");
  });

  it("refuses a line naming a parameter the occasion does not declare", () => {
    const line = { text: "See %1", parameters: ["total"] };
    const { issues } = validatePhisAddonManifest(manifest({ occasions: [{ ...orderPaid, lines: [line] }] }));
    expect(issues).toContain(
      "occasions[0].lines[0].parameters[0] does not name a parameter this occasion declares.",
    );
  });

  it("keeps Core's own parameter names for Core", () => {
    const reserved = { ...orderPaid, parameters: [...orderPaid.parameters, { name: "recipientName", type: "text" }] };
    expect(validatePhisAddonManifest(manifest({ occasions: [reserved] })).issues)
      .toContain("occasions[0].parameters[2].name is reserved for Core.");
  });

  it("refuses two occasions of one name, an unknown parameter type and an empty body", () => {
    expect(validatePhisAddonManifest(manifest({ occasions: [orderPaid, orderPaid] })).issues)
      .toContain('occasions contains duplicate "order-paid".');
    const typed = { ...orderPaid, parameters: [{ name: "number", type: "url" }, orderPaid.parameters[1]] };
    expect(validatePhisAddonManifest(manifest({ occasions: [typed] })).issues)
      .toContain("occasions[0].parameters[0].type must be text or path.");
    expect(validatePhisAddonManifest(manifest({ occasions: [{ ...orderPaid, lines: [] }] })).issues)
      .toContain("occasions[0].lines must be a non-empty array.");
  });
});
