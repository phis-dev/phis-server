import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseSiteAuthConfiguration } from "@/db/site-auth";

const policy = {
  registrationMode: "automatic",
  existingAccountLinking: "verified-email-confirm",
  allowPrivilegedAutoLink: false,
  passwordPolicy: {},
  passkeyPolicy: {},
  factorPolicy: {},
  recoveryPolicy: {},
  sessionPolicy: {},
  allowedCallbackOrigins: [],
};

describe("Site Auth JSON configuration", () => {
  it("normalizes policy, methods, and provider installations from one document", () => {
    const config = parseSiteAuthConfiguration(7, {
      policy,
      providers: [{
        installationKey: "google",
        providerKey: "google",
        issuer: "https://accounts.google.com",
        clientId: "client-id",
        secretReference: "site:skeleton:google",
        config: { hostedDomains: ["example.com"] },
        enabled: true,
      }],
      methods: [{
        methodKey: "google",
        stage: "primary",
        installationKey: "google",
        enabled: true,
        sortOrder: 20,
        presentation: { label: "Google" },
      }],
    });

    expect(config.providers[0]?.installationKey).toBe("google");
    expect(config.methods[0]?.providerInstallationKey).toBe("google");
    expect(config.policy.registrationMode).toBe("automatic");
  });

  it("rejects a method that points to an unknown provider installation", () => {
    expect(() => parseSiteAuthConfiguration(7, {
      policy,
      providers: [],
      methods: [{
        methodKey: "google",
        stage: "primary",
        installationKey: "missing",
        enabled: true,
        sortOrder: 20,
        presentation: {},
      }],
    })).toThrow("Unknown Auth provider installation missing");
  });

  it("rejects duplicate method/stage entries", () => {
    const method = {
      methodKey: "password",
      stage: "primary",
      installationKey: null,
      enabled: true,
      sortOrder: 10,
      presentation: {},
    };
    expect(() => parseSiteAuthConfiguration(7, {
      policy,
      providers: [],
      methods: [method, method],
    })).toThrow("Duplicate Auth method/stage");
  });

  it("normalizes the required-factor enforcement policy", () => {
    const config = parseSiteAuthConfiguration(7, {
      policy: {
        ...policy,
        factorPolicy: {
          requiredMethod: "totp",
          enforcement: "immediate",
          graceUntil: null,
          roleFlags: 1,
        },
      },
      providers: [],
      methods: [{
        methodKey: "totp",
        stage: "second-factor",
        installationKey: null,
        enabled: true,
        sortOrder: 10,
        presentation: {},
      }],
    });

    expect(config.policy.factorPolicy).toEqual({
      requiredMethod: "totp",
      enforcement: "immediate",
      graceUntil: null,
      roleFlags: 1,
    });
  });

  it("rejects a grace policy without a deadline", () => {
    expect(() => parseSiteAuthConfiguration(7, {
      policy: {
        ...policy,
        factorPolicy: {
          requiredMethod: "totp",
          enforcement: "grace",
          graceUntil: null,
          roleFlags: 0,
        },
      },
      providers: [],
      methods: [],
    })).toThrow("requires graceUntil");
  });
});
