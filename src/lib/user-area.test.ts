import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PhiBaseRole } from "@/lib/constants/phi-base-roles";
import { PhiUserAccountFlag } from "@/lib/constants/user-account-flags";
import { resolvePhiUserArea } from "./user-area";

const admin = [{ providerId: "@phis/server/core" as const, flags: PhiBaseRole.Admin }];

describe("the Area a signed-in person lands in", () => {
  it("follows the roles", () => {
    expect(resolvePhiUserArea({ authenticated: true, roleClaims: admin })).toBe("admin");
  });

  // The App carries the password Form, and every other Area's data refuses the session until then.
  it("is the App while a password change is outstanding, whatever the roles", () => {
    expect(resolvePhiUserArea({
      authenticated: true,
      roleClaims: admin,
      accountFlags: PhiUserAccountFlag.MustChangePassword,
    })).toBe("app");
  });
});
