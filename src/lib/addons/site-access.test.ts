import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ role: vi.fn() }));
vi.mock("@/db/user-site-memberships", () => ({ getEffectiveUserSiteAuthorization: mocks.role }));

import { PHIS_SITE_ACCESS } from "./contract.ts";
import {
  holdsPhisSiteAccess,
  phisSiteAccessCoreRoleFlags,
  phisSiteAccessHeldBy,
  phisSiteAccessHolderOf,
  PHIS_SITE_ACCESS_POLICIES,
  readPhisSiteAccessHolder,
} from "./site-access";
import { PHI_CORE_ROLE_PROVIDER_ID } from "@/lib/authorization";
import { PhiBaseRole } from "@/lib/constants/phi-base-roles";

/** One table and one check, read by `authorization:v1` and by the role-granting rule alike. */
describe("an Add-on's Site access question", () => {
  beforeEach(() => {
    mocks.role.mockReset().mockResolvedValue({
      enabled: true,
      roleClaims: [{ providerId: PHI_CORE_ROLE_PROVIDER_ID, flags: PhiBaseRole.Admin }],
      groupClaims: [],
    });
  });

  it("names a policy for every access the contract declares", () => {
    for (const access of Object.values(PHIS_SITE_ACCESS)) {
      expect(PHIS_SITE_ACCESS_POLICIES[access]).toBeDefined();
    }
  });

  it("answers yes for a Site Admin with an enabled membership", async () => {
    expect(await holdsPhisSiteAccess(7, 41, PHIS_SITE_ACCESS.support)).toBe(true);
  });

  it("answers no for a disabled membership and for an access nobody declared", async () => {
    expect(await holdsPhisSiteAccess(7, 41, "invented")).toBe(false);
    mocks.role.mockResolvedValue({ enabled: false, roleClaims: [], groupClaims: [] });
    expect(await holdsPhisSiteAccess(7, 41, PHIS_SITE_ACCESS.siteAdmin)).toBe(false);
  });

  it("answers from a snapshot already read, as the Site viewer has one", () => {
    const claims = [{ providerId: PHI_CORE_ROLE_PROVIDER_ID, flags: PhiBaseRole.Admin }];
    expect(phisSiteAccessHeldBy({ enabled: true, roleClaims: claims, groupClaims: [] }, PHIS_SITE_ACCESS.siteAdmin)).toBe(true);
    expect(phisSiteAccessHeldBy({ enabled: false, roleClaims: claims, groupClaims: [] }, PHIS_SITE_ACCESS.siteAdmin)).toBe(false);
    expect(phisSiteAccessHeldBy({ enabled: true, roleClaims: [], groupClaims: [] }, PHIS_SITE_ACCESS.siteAdmin)).toBe(false);
  });

  it("answers every access from one read of the snapshot", async () => {
    mocks.role.mockResolvedValue({
      enabled: true,
      roleClaims: [{ providerId: PHI_CORE_ROLE_PROVIDER_ID, flags: PhiBaseRole.Accountant }],
      groupClaims: [],
    });
    const holds = await readPhisSiteAccessHolder(7, 41);
    expect(holds(PHIS_SITE_ACCESS.accounting)).toBe(true);
    expect(holds(PHIS_SITE_ACCESS.support)).toBe(false);
    expect(holds(PHIS_SITE_ACCESS.siteAdmin)).toBe(false);
    expect(mocks.role).toHaveBeenCalledTimes(1);
    expect(mocks.role).toHaveBeenCalledWith(41, 7);

    const supporter = phisSiteAccessHolderOf({
      enabled: true,
      roleClaims: [{ providerId: PHI_CORE_ROLE_PROVIDER_ID, flags: PhiBaseRole.Supporter }],
      groupClaims: [],
    });
    expect(supporter(PHIS_SITE_ACCESS.support)).toBe(true);
    expect(supporter(PHIS_SITE_ACCESS.accounting)).toBe(false);
  });

  it("puts every access as the Core role mask its policy is, for a filter written in SQL", () => {
    expect(phisSiteAccessCoreRoleFlags(PHIS_SITE_ACCESS.accounting)).toBe(PhiBaseRole.Developer | PhiBaseRole.Accountant);
    expect(phisSiteAccessCoreRoleFlags(PHIS_SITE_ACCESS.support)).toBe(PhiBaseRole.Developer | PhiBaseRole.Supporter);
    for (const access of Object.values(PHIS_SITE_ACCESS)) {
      expect(phisSiteAccessCoreRoleFlags(access)).toBeGreaterThan(0);
    }
  });
});
