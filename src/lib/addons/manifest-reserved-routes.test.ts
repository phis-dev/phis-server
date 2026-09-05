import { describe, expect, it } from "vitest";

import { validatePhisAddonManifest } from "./manifest.ts";

/**
 * The one path under an Add-on's root that is not the Add-on's.
 *
 * Core serves the slot lifecycle there, so a surface that fills a slot needs to know the Add-on, the
 * table and the slot rather than somebody's route names -- and every Add-on with slots is spared the
 * five routes it would otherwise write to say the same thing.
 *
 * Nothing had to be added to keep it free. A route segment must begin with a letter or a digit, so an
 * Add-on cannot declare one that starts with an underscore -- which is why Core's own paths under the
 * root start with one. The reservation is a property of the grammar rather than a list somebody has to
 * remember to extend, and every later Core-owned path is reserved by being spelled the same way.
 */

function manifestWith(routes: unknown[], hooks: unknown[] = []) {
  return {
    manifestVersion: 1,
    addonId: "@acme/status",
    packageName: "@acme/status",
    packageVersion: "1.0.0",
    serverAbi: "^1",
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: [],
    apiRoutes: routes,
    hooks,
    jobs: [],
    schema: null,
    migrationVersion: 0,
  };
}

function route(path: string) {
  return {
    id: "thing",
    method: "GET",
    path,
    handler: "thing",
    auth: "site-user",
    siteScoped: true,
  };
}

describe("the reserved segment under an Add-on's root", () => {
  it("refuses a route that would shadow it", () => {
    expect(validatePhisAddonManifest(manifestWith([route("_assets/offering/1")])).issues.join("\n"))
      .toMatch(/invalid segment "_assets"/);
  });

  it("refuses any leading underscore, which is what makes the reservation hold", () => {
    // Not `_assets` by name: the grammar refuses the shape, so the next Core path under the root is
    // free without anybody adding it to a list.
    expect(validatePhisAddonManifest(manifestWith([route("_anything")])).issues.join("\n"))
      .toMatch(/invalid segment "_anything"/);
  });

  it("leaves an underscore alone where it is not the first character", () => {
    expect(validatePhisAddonManifest(manifestWith([route("offering_assets")])).issues).toEqual([]);
  });
});
