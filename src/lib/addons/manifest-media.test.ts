import { describe, expect, it } from "vitest";

import { validatePhisAddonManifest } from "./manifest.ts";

/** What an Add-on takes as Media through its own Forms, which the Site UI applies in its Module's Media fields. */

function manifest(extra: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    addonId: "@acme/shop",
    packageName: "@acme/shop",
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

const issuesOf = (media: unknown) => validatePhisAddonManifest(manifest({ media })).issues;

describe("media in a manifest", () => {
  it("admits every limit, any one of them, none, and a manifest that states no media", () => {
    expect(issuesOf({ maxFileBytes: 10_485_760, kinds: ["image", "pdf"], maxPerField: 20 })).toEqual([]);
    expect(issuesOf({ kinds: ["image"] })).toEqual([]);
    expect(issuesOf({})).toEqual([]);
    expect(validatePhisAddonManifest(manifest()).issues).toEqual([]);
  });

  it("refuses a limit that is not a positive whole number", () => {
    for (const value of [0, -1, 1.5, "20", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(issuesOf({ maxFileBytes: value }), String(value)).toContain("media.maxFileBytes must be a positive integer.");
      expect(issuesOf({ maxPerField: value }), String(value)).toContain("media.maxPerField must be a positive integer.");
    }
  });

  it("refuses a kind the Media library does not know, an empty or duplicate list, and a key it does not state", () => {
    expect(issuesOf({ kinds: ["image", "picture"] }).join("\n")).toMatch(/media\.kinds\[1\] must be one of image, /);
    expect(issuesOf({ kinds: [7] }).join("\n")).toMatch(/media\.kinds\[0\] must be one of/);
    expect(issuesOf({ kinds: [] })).toContain("media.kinds must be a non-empty array of Media kinds when it is stated at all.");
    expect(issuesOf({ kinds: "image" })).toContain("media.kinds must be a non-empty array of Media kinds when it is stated at all.");
    expect(issuesOf({ kinds: ["image", "image"] })).toContain('media.kinds contains duplicate "image".');
    expect(issuesOf({ maxBytes: 10 }).join("\n")).toMatch(/media\.maxBytes is not a Media limit/);
    expect(issuesOf([])).toContain("media must be an object when it is stated at all.");
    expect(issuesOf("image")).toContain("media must be an object when it is stated at all.");
  });
});
