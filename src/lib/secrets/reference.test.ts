import { describe, expect, it } from "vitest";

import {
  buildPhiSecretReference,
  canPhiSecretOwnerResolve,
  isPhiSecretReference,
  parsePhiSecretReference,
} from "./reference";

describe("buildPhiSecretReference", () => {
  it("names a deployment-wide Core secret", () => {
    expect(buildPhiSecretReference({ owner: { kind: "core" }, siteKey: null, name: "smtp-password" }))
      .toBe("core:smtp-password");
  });

  it("names a Site-scoped Core secret", () => {
    expect(buildPhiSecretReference({ owner: { kind: "core" }, siteKey: "acme", name: "smtp-password" }))
      .toBe("site:acme:core:smtp-password");
  });

  it("names an Add-on secret", () => {
    expect(buildPhiSecretReference({
      owner: { kind: "addon", addonId: "@phis/github" },
      siteKey: null,
      name: "app-private-key",
    })).toBe("addon:@phis/github:app-private-key");
  });

  it("names a Site-scoped Add-on secret", () => {
    expect(buildPhiSecretReference({
      owner: { kind: "addon", addonId: "@phis/storage-s3" },
      siteKey: "acme",
      name: "secret-access-key",
    })).toBe("site:acme:addon:@phis/storage-s3:secret-access-key");
  });

  it("lowercases what it is given", () => {
    expect(buildPhiSecretReference({ owner: { kind: "core" }, siteKey: "ACME", name: "Token" }))
      .toBe("site:acme:core:token");
  });

  it("refuses a name that would break the format", () => {
    for (const name of ["with:colon", "with space", "", "-leading"]) {
      expect(() => buildPhiSecretReference({ owner: { kind: "core" }, siteKey: null, name }))
        .toThrow();
    }
  });

  it("refuses an Add-on id that is not namespaced", () => {
    expect(() => buildPhiSecretReference({
      owner: { kind: "addon", addonId: "github" },
      siteKey: null,
      name: "token",
    })).toThrow(/namespaced/u);
  });
});

describe("parsePhiSecretReference", () => {
  it("round-trips every shape it builds", () => {
    const identities = [
      { owner: { kind: "core" as const }, siteKey: null, name: "smtp-password" },
      { owner: { kind: "core" as const }, siteKey: "acme", name: "smtp-password" },
      { owner: { kind: "addon" as const, addonId: "@phis/github" }, siteKey: null, name: "webhook-secret" },
      { owner: { kind: "addon" as const, addonId: "@phis/storage-s3" }, siteKey: "acme", name: "secret-access-key" },
    ];
    for (const identity of identities) {
      expect(parsePhiSecretReference(buildPhiSecretReference(identity))).toEqual(identity);
    }
  });

  it("rejects anything it did not build", () => {
    for (const value of [
      "",
      "smtp-password",
      "site:acme",
      "site:acme:core",
      "addon:github:token",
      "core:token:extra",
      "site::core:token",
      "vendor:acme:token",
    ]) {
      expect(parsePhiSecretReference(value)).toBeNull();
      expect(isPhiSecretReference(value)).toBe(false);
    }
  });

  it("rejects a reference beyond the column width", () => {
    expect(isPhiSecretReference(`core:${"a".repeat(600)}`)).toBe(false);
  });
});

describe("canPhiSecretOwnerResolve", () => {
  const core = { kind: "core" as const };
  const github = { kind: "addon" as const, addonId: "@phis/github" };
  const storage = { kind: "addon" as const, addonId: "@phis/storage-s3" };

  it("lets Core resolve anything", () => {
    expect(canPhiSecretOwnerResolve(core, "addon:@phis/github:webhook-secret")).toBe(true);
    expect(canPhiSecretOwnerResolve(core, "core:smtp-password")).toBe(true);
  });

  it("keeps an Add-on inside its own namespace", () => {
    expect(canPhiSecretOwnerResolve(github, "addon:@phis/github:webhook-secret")).toBe(true);
    expect(canPhiSecretOwnerResolve(github, "site:acme:addon:@phis/github:webhook-secret")).toBe(true);
    expect(canPhiSecretOwnerResolve(github, "addon:@phis/storage-s3:secret-access-key")).toBe(false);
    expect(canPhiSecretOwnerResolve(storage, "core:smtp-password")).toBe(false);
  });

  it("refuses a reference it cannot read", () => {
    expect(canPhiSecretOwnerResolve(core, "not a reference")).toBe(false);
  });
});
