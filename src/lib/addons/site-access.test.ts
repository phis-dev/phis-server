import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ role: vi.fn() }));
vi.mock("@/db/user-site-memberships", () => ({ getEffectiveUserSiteAuthorization: mocks.role }));

import { PHIS_SITE_ACCESS } from "./contract.ts";
import { holdsPhisSiteAccess, PHIS_SITE_ACCESS_POLICIES } from "./site-access";
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
});
