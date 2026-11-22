import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ grants: [] as Array<{ addonId: string; role: string }>, reads: 0 }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/server-addon-roles.mts", () => ({
  readPhiSiteUserAddonRoles: async () => {
    mocks.reads += 1;
    return mocks.grants;
  },
}));
vi.mock("./installed.ts", () => ({
  getPhisAddonInstalledManifest: () => ({
    "@acme/shop": { enabled: true, manifest: { roles: [{ name: "clerk" }] } },
    "@acme/books": {
      enabled: true,
      manifest: {
        roles: [
          { name: "keeper", impliedBy: { siteAccess: "accounting" }, includes: ["reader"] },
          { name: "reader" },
          { name: "auditor" },
        ],
      },
    },
    "@acme/blog": { enabled: true, manifest: { roles: [{ name: "writer" }] } },
    "@acme/off": { enabled: false, manifest: { roles: [{ name: "x" }] } },
    "@acme/plain": { enabled: true, manifest: {} },
  }),
}));

import { readPhiViewerAddonRoleClaims } from "./viewer-roles";

/** Who holds which Site access, as `phisSiteAccessHolderOf` answers it from the request's snapshot. */
const holding = (...accesses: string[]) => (access: string) => accesses.includes(access);
const siteAdmin = holding("site-admin");
const nobody = holding();

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
    mocks.reads = 0;
  });

  it("names the roles of available Add-ons only, and only roles the manifest declares", async () => {
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/shop"]), nobody)).toEqual([
      { providerId: "@acme/shop", roles: ["clerk"] },
    ]);
  });

  it("gives a Site Admin every declared role of every available Add-on without reading a stored grant", async () => {
    mocks.grants = [];
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/shop", "@acme/blog", "@acme/off", "@acme/plain"]), siteAdmin))
      .toEqual([
        { providerId: "@acme/shop", roles: ["clerk"] },
        { providerId: "@acme/blog", roles: ["writer"] },
      ]);
    expect(mocks.reads).toBe(0);
    // Not available on the Site: no claim, admin or not.
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/shop"]), siteAdmin)).toEqual([
      { providerId: "@acme/shop", roles: ["clerk"] },
    ]);
  });

  it("leaves a user who is not Site Admin with no claim when nothing is stored", async () => {
    mocks.grants = [];
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/shop"]), nobody)).toEqual([]);
  });

  it("carries the roles a Site access implies, with what they include, with nothing stored", async () => {
    mocks.grants = [];
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/shop", "@acme/books"]), holding("accounting")))
      .toEqual([{ providerId: "@acme/books", roles: ["keeper", "reader"] }]);
    // Without the access, or with the Add-on not available here, the role is not carried.
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/shop", "@acme/books"]), holding("support"))).toEqual([]);
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/shop"]), holding("accounting"))).toEqual([]);
  });

  it("carries an implied role beside the stored ones of the same Add-on", async () => {
    mocks.grants = [{ addonId: "@acme/books", role: "auditor" }];
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/books"]), holding("accounting")))
      .toEqual([{ providerId: "@acme/books", roles: ["keeper", "reader", "auditor"] }]);
    expect(await readPhiViewerAddonRoleClaims(1, 7, new Set(["@acme/books"]), nobody))
      .toEqual([{ providerId: "@acme/books", roles: ["auditor"] }]);
  });
});
