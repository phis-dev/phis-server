import { describe, expect, it } from "vitest";

import { decideExternalAccountResolution } from "./account-linking";
import { normalizeAuthNextPath } from "./contracts";

const baseline = {
  identityUserId: null,
  emailUserId: null,
  hasMembership: false,
  accountEnabled: true,
  emailVerified: true,
  registrationMode: "automatic" as const,
  linkingMode: "verified-email-confirm" as const,
  trustedForAutoLink: false,
  privileged: false,
  allowPrivilegedAutoLink: false,
};

describe("external account resolution", () => {
  it("uses an already linked identity and creates only an automatic membership", () => {
    expect(decideExternalAccountResolution({
      ...baseline,
      identityUserId: 12,
      hasMembership: true,
    })).toBe("use-linked-user");
    expect(decideExternalAccountResolution({
      ...baseline,
      identityUserId: 12,
      registrationMode: "invite-only",
    })).toBe("membership-required");
  });

  it("never links a matching email merely because it exists", () => {
    expect(decideExternalAccountResolution({
      ...baseline,
      emailUserId: 15,
    })).toBe("link-required");
  });

  it("permits only explicitly trusted automatic email linking", () => {
    expect(decideExternalAccountResolution({
      ...baseline,
      emailUserId: 15,
      linkingMode: "verified-email-auto",
      trustedForAutoLink: true,
    })).toBe("link-existing-user");
  });

  it("protects privileged accounts unless the site explicitly opts in", () => {
    expect(decideExternalAccountResolution({
      ...baseline,
      emailUserId: 15,
      linkingMode: "verified-email-auto",
      trustedForAutoLink: true,
      privileged: true,
    })).toBe("link-required");
  });

  it("requires a verified provider email before creating an account", () => {
    expect(decideExternalAccountResolution({
      ...baseline,
      emailVerified: false,
    })).toBe("verified-email-required");
  });

  it("creates a global account only when registration is automatic", () => {
    expect(decideExternalAccountResolution(baseline)).toBe("create-user");
    expect(decideExternalAccountResolution({
      ...baseline,
      registrationMode: "disabled",
    })).toBe("registration-disabled");
  });
});

describe("post-authentication redirect normalization", () => {
  it("keeps local paths and rejects absolute or protocol-relative redirects", () => {
    expect(normalizeAuthNextPath("/account?tab=security")).toBe("/account?tab=security");
    expect(normalizeAuthNextPath("https://attacker.invalid/path")).toBe("/");
    expect(normalizeAuthNextPath("//attacker.invalid/path")).toBe("/");
    expect(normalizeAuthNextPath("javascript:alert(1)")).toBe("/");
  });
});
