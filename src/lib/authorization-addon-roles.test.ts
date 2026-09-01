import { describe, expect, it } from "vitest";

import {
  canPhiViewerAccess,
  type PhiAuthorizationViewer,
  type PhiViewerAccessPolicy,
} from "./authorization";

/**
 * The server's own copy of the access model, on the Add-on role policy.
 *
 * phi-server does not depend on `@phis/ui`, so the evaluator exists twice and the two have to agree.
 * They are checked separately and against the same cases: a viewer denied on one side and admitted on
 * the other is the worst shape this pair can take, because each side looks correct on its own.
 */

const MARKET = "@acme/market" as const;
const vendorOnly: PhiViewerAccessPolicy = {
  access: "addon-roles",
  providerId: MARKET,
  allowedRoles: ["vendor"],
};

function viewer(roles: string[] | null): PhiAuthorizationViewer {
  return {
    authenticated: true,
    roleClaims: [],
    groupClaims: [],
    ...(roles === null ? {} : { addonRoleClaims: [{ providerId: MARKET, roles }] }),
  };
}

describe("an addon-roles policy on the server", () => {
  it("admits somebody holding one of the named roles", () => {
    expect(canPhiViewerAccess(viewer(["vendor"]), vendorOnly)).toBe(true);
    expect(canPhiViewerAccess(viewer(["reviewer", "vendor"]), vendorOnly)).toBe(true);
  });

  it("refuses other roles, an absent claim set, and an anonymous viewer", () => {
    expect(canPhiViewerAccess(viewer(["reviewer"]), vendorOnly)).toBe(false);
    expect(canPhiViewerAccess(viewer(null), vendorOnly)).toBe(false);
    expect(canPhiViewerAccess(
      { authenticated: false, roleClaims: [], groupClaims: [] },
      vendorOnly,
    )).toBe(false);
  });

  it("does not match the same name from another Add-on", () => {
    expect(canPhiViewerAccess({
      authenticated: true,
      roleClaims: [],
      groupClaims: [],
      addonRoleClaims: [{ providerId: "@acme/other", roles: ["vendor"] }],
    }, vendorOnly)).toBe(false);
  });

  it("refuses a policy naming no role at all", () => {
    expect(canPhiViewerAccess(viewer(["vendor"]), {
      access: "addon-roles",
      providerId: MARKET,
      allowedRoles: [],
    })).toBe(false);
  });
});
