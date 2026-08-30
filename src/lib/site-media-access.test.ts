import { describe, expect, it } from "vitest";

import {
  canPhiViewerAccess,
  PHI_ACCESS_SITE_MEDIA,
  PHI_CORE_ROLE_PROVIDER_ID,
} from "@/lib/authorization";
import { PhiBaseRole } from "@/lib/constants/phi-base-roles";

function viewer(roleFlags: number) {
  return {
    authenticated: true,
    roleClaims: [{ providerId: PHI_CORE_ROLE_PROVIDER_ID, flags: roleFlags }],
    groupClaims: [],
  };
}

describe("Site Media management policy", () => {
  it("admits the four content roles", () => {
    for (const role of ["Builder", "Author", "Publisher", "Developer"] as const) {
      expect(canPhiViewerAccess(viewer(PhiBaseRole[role]), PHI_ACCESS_SITE_MEDIA), role).toBe(true);
    }
  });

  it("admits Core Admin through the override rather than through the mask", () => {
    expect(PHI_ACCESS_SITE_MEDIA.allowedRoleFlags & PhiBaseRole.Admin).toBe(0);
    expect(canPhiViewerAccess(viewer(PhiBaseRole.Admin), PHI_ACCESS_SITE_MEDIA)).toBe(true);
  });

  it("refuses Supporter and Accountant", () => {
    for (const role of ["Supporter", "Accountant"] as const) {
      expect(canPhiViewerAccess(viewer(PhiBaseRole[role]), PHI_ACCESS_SITE_MEDIA), role).toBe(false);
    }
  });

  it("refuses an authenticated user without any Site role", () => {
    expect(canPhiViewerAccess(viewer(0), PHI_ACCESS_SITE_MEDIA)).toBe(false);
    expect(canPhiViewerAccess(
      { authenticated: true, roleClaims: [], groupClaims: [] },
      PHI_ACCESS_SITE_MEDIA,
    )).toBe(false);
  });

  it("refuses an anonymous viewer", () => {
    expect(canPhiViewerAccess(
      { authenticated: false, roleClaims: [], groupClaims: [] },
      PHI_ACCESS_SITE_MEDIA,
    )).toBe(false);
  });

  it("refuses a matching role flag issued by a foreign provider", () => {
    expect(canPhiViewerAccess({
      authenticated: true,
      roleClaims: [{ providerId: "@acme/github", flags: PhiBaseRole.Builder }],
      groupClaims: [],
    }, PHI_ACCESS_SITE_MEDIA)).toBe(false);
  });
});
