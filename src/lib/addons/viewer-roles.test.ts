import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ grants: [] as Array<{ addonId: string; role: string }> }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/server-addon-roles.mts", () => ({ readPhiSiteUserAddonRoles: async () => mocks.grants }));
vi.mock("./installed.ts", () => ({
  getPhisAddonInstalledManifest: () => ({
    "@acme/shop": { enabled: true, manifest: { roles: [{ name: "clerk" }] } },
    "@acme/blog": { enabled: true, manifest: { roles: [{ name: "writer" }] } },
    "@acme/off": { enabled: false, manifest: { roles: [{ name: "x" }] } },
    "@acme/plain": { enabled: true, manifest: {} },
  }),
}));

import { readPhiViewerAddonRoleClaims } from "./viewer-roles";

/**
 * Whether an Add-on's roles count here is the snapshot's answer, handed in by the authorization read,
 * rather than two registry statements per Add-on on every signed-in page view.
 */
describe("the viewer's Add-on roles", () => {
  beforeEach(() => {
    mocks.grants = [
      { addonId: "@acme/shop", role: "clerk" },
      { addonId: "@acme/blog", role: "writer" },
      { addonId: "@acme/shop", role: "undeclared" },
    ];
  });

  it("names the roles of available Add-ons only, and only roles the manifest declares", async () => {
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/shop"]))).toEqual([
      { providerId: "@acme/shop", roles: ["clerk"] },
    ]);
  });

  it("gives a Site Admin every declared role of every available Add-on without reading a stored grant", async () => {
    mocks.grants = [];
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/shop", "@acme/blog", "@acme/off", "@acme/plain"]), true))
      .toEqual([
        { providerId: "@acme/shop", roles: ["clerk"] },
        { providerId: "@acme/blog", roles: ["writer"] },
      ]);
    // Not available on the Site: no claim, admin or not.
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/shop"]), true)).toEqual([
      { providerId: "@acme/shop", roles: ["clerk"] },
    ]);
  });

  it("leaves a user who is not Site Admin with no claim when nothing is stored", async () => {
    mocks.grants = [];
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/shop"]), false)).toEqual([]);
  });
});
