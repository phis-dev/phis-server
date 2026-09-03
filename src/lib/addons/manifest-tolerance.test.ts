import { describe, expect, it } from "vitest";

import { validatePhisAddonManifest } from "./manifest.ts";

/**
 * What a manifest written before a field existed must still be.
 *
 * An Add-on installed today stores its manifest as it was built. When Core later learns a new
 * declaration, that stored manifest has not become wrong -- its author had not forgotten the field, it
 * did not exist. Refusing it would make an ordinary upgrade of Core lock every installation out, and
 * the digest means the file cannot be repaired by hand either.
 *
 * So: a field added after this manifest version was in the wild is optional and defines what absence
 * means. Only a wrong shape is an issue.
 */

function manifest(extra: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    addonId: "@acme/status",
    packageName: "@acme/status",
    packageVersion: "1.0.0",
    serverAbi: "^1",
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: [],
    apiRoutes: [],
    hooks: [],
    jobs: [],
    schema: null,
    migrationVersion: 0,
    ...extra,
  };
}

describe("a manifest from before the newest fields", () => {
  it("is accepted without settings or queries", () => {
    const result = validatePhisAddonManifest(manifest());
    expect(result.issues).toEqual([]);
    expect(result.manifest).not.toBeNull();
  });

  it("still refuses either one when it is stated wrongly", () => {
    expect(validatePhisAddonManifest(manifest({ settings: "some" })).issues.join("\n"))
      .toMatch(/settings must be an array when it is stated at all/);
    // Stated at all means checked in full: this Add-on owns no tables, so it can declare no queries.
    expect(validatePhisAddonManifest(manifest({ queries: { queries: [] } })).issues.join("\n"))
      .toMatch(/owns no tables to run them against/);
  });

  it("takes a hook that predates siteScoped, and refuses one that states it wrongly", () => {
    const hook = {
      id: "listing",
      method: "GET",
      path: "packages",
      handler: "listing",
      bodyLimitBytes: 1024,
      rateLimitClass: "listing",
      timeoutMs: 5000,
    };
    expect(validatePhisAddonManifest(manifest({ hooks: [hook] })).issues).toEqual([]);
    expect(validatePhisAddonManifest(manifest({ hooks: [{ ...hook, siteScoped: true }] })).issues)
      .toEqual([]);
    expect(
      validatePhisAddonManifest(manifest({ hooks: [{ ...hook, siteScoped: "yes" }] }))
        .issues.join("\n"),
    ).toMatch(/siteScoped must be a boolean when it is stated at all/);
  });

  it("refuses a manifest missing a field that has always been required", () => {
    const { schema: _schema, ...withoutSchema } = manifest();
    expect(validatePhisAddonManifest(withoutSchema).issues.join("\n"))
      .toMatch(/schema must be a descriptor object or null/);
  });
});
