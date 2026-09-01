import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
  grantPhiServerAddonUserRole,
  readPhiServerAddonOrphanedRoles,
  readPhiSiteUserAddonRoles,
  revokePhiServerAddonUserRole,
} from "./server-addon-roles.mts";
import { buildPhiServerAddonRolesCapability } from "@/lib/addons/roles-capability";
import { mayGrantPhiServerAddonRole } from "@/lib/addons/role-granting";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * Roles an Add-on defines, held by real people, on a real Site.
 *
 * What only PostgreSQL can settle: that a grant survives being made twice, that it disappears with the
 * user, and that the capability reads back the Add-on's declared vocabulary rather than whatever has
 * accumulated in the table across versions.
 */

const ADDON = "@pgtest/market";
const DECLARED = [
  { name: "market-admin", grantableBy: { siteAccess: "site-admin" as const } },
  { name: "vendor", grantableBy: { role: "market-admin" } },
];

describe("Add-on roles", () => {
  let site: PhiTestSite;
  let vendor: number;
  let admin: number;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-roles");
    vendor = await createPhiTestUser(site);
    admin = await createPhiTestUser(site);
    const pool = await requirePhiTestDatabase();
    // The Add-on has to exist before a grant may point at it: the assignment references the installed
    // row, which is what keeps grants for something nobody installed out of the table.
    await pool.query(
      `INSERT INTO phis.server_addons
         (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
       VALUES ($1, '@pgtest/market-server', '1.0.0', '1', repeat('0', 64), 'pgtest')
       ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON],
    );
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.site_addon_user_roles WHERE addon_id = $1`, [ADDON]);
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await closePhiTestPool();
  });

  function capabilityFor(actorUserId: number | null) {
    return buildPhiServerAddonRolesCapability({
      addonId: ADDON,
      siteId: site.id,
      actorUserId,
      declared: DECLARED,
    });
  }

  it("grants once, and says so when a second grant adds nothing", async () => {
    const pool = await requirePhiTestDatabase();
    const input = { addonId: ADDON, siteId: site.id, userId: vendor, role: "vendor", grantedByUserId: admin };
    expect(await grantPhiServerAddonUserRole(pool, input)).toBe(true);
    expect(await grantPhiServerAddonUserRole(pool, input)).toBe(false);
    expect(await capabilityFor(vendor).has("vendor")).toBe(true);
  });

  it("answers no for somebody who holds nothing, and for nobody at all", async () => {
    expect(await capabilityFor(admin).has("vendor")).toBe(false);
    expect(await capabilityFor(null).has("vendor")).toBe(false);
    expect(await capabilityFor(null).all()).toEqual([]);
  });

  it("does not hand over a role the manifest no longer declares", async () => {
    const pool = await requirePhiTestDatabase();
    await grantPhiServerAddonUserRole(pool, {
      addonId: ADDON, siteId: site.id, userId: vendor, role: "retired-role", grantedByUserId: null,
    });
    expect(await capabilityFor(vendor).all()).toEqual(["vendor"]);
    expect(await capabilityFor(vendor).has("retired-role")).toBe(false);

    // Not handed over, but not gone either: the operator is told, and decides.
    const orphans = await readPhiServerAddonOrphanedRoles(pool, {
      addonId: ADDON,
      declared: DECLARED.map((role) => role.name),
    });
    expect(orphans).toEqual([{ siteId: site.id, role: "retired-role", holders: 1 }]);
  });

  it("reports what one person holds across Add-ons", async () => {
    const pool = await requirePhiTestDatabase();
    const held = await readPhiSiteUserAddonRoles(pool, { siteId: site.id, userId: vendor });
    expect(held.map((entry) => `${entry.addonId}:${entry.role}`)).toContain(`${ADDON}:vendor`);
    expect(held[0]!.grantedAt).toBeInstanceOf(Date);
  });

  it("refuses a grant from somebody who holds neither the access nor the granting role", async () => {
    const verdict = await mayGrantPhiServerAddonRole({
      addonId: ADDON, siteId: site.id, actorUserId: vendor, role: "vendor", declared: DECLARED,
    });
    expect(verdict).toEqual({ allowed: false, reason: "not_permitted" });
  });

  it("allows a grant from somebody holding the role the policy names", async () => {
    const pool = await requirePhiTestDatabase();
    await grantPhiServerAddonUserRole(pool, {
      addonId: ADDON, siteId: site.id, userId: admin, role: "market-admin", grantedByUserId: null,
    });
    const verdict = await mayGrantPhiServerAddonRole({
      addonId: ADDON, siteId: site.id, actorUserId: admin, role: "vendor", declared: DECLARED,
    });
    expect(verdict.allowed).toBe(true);
  });

  it("refuses a role nobody declared, and an Add-on nobody installed", async () => {
    expect(await mayGrantPhiServerAddonRole({
      addonId: ADDON, siteId: site.id, actorUserId: admin, role: "nonesuch", declared: DECLARED,
    })).toEqual({ allowed: false, reason: "role_undeclared" });
    expect(await mayGrantPhiServerAddonRole({
      addonId: "@pgtest/absent", siteId: site.id, actorUserId: admin, role: "vendor", declared: null,
    })).toEqual({ allowed: false, reason: "addon_unknown" });
  });

  it("takes the grants with the user", async () => {
    const pool = await requirePhiTestDatabase();
    const doomed = await createPhiTestUser(site);
    await grantPhiServerAddonUserRole(pool, {
      addonId: ADDON, siteId: site.id, userId: doomed, role: "vendor", grantedByUserId: null,
    });
    await pool.query(`DELETE FROM phis.user_accounts WHERE id = $1`, [doomed]);
    const { rows } = await pool.query(
      `SELECT 1 FROM phis.site_addon_user_roles WHERE user_id = $1`,
      [doomed],
    );
    expect(rows).toHaveLength(0);
  });

  it("revokes, and says so when there was nothing to revoke", async () => {
    const pool = await requirePhiTestDatabase();
    const input = { addonId: ADDON, siteId: site.id, userId: vendor, role: "vendor" };
    expect(await revokePhiServerAddonUserRole(pool, input)).toBe(true);
    expect(await revokePhiServerAddonUserRole(pool, input)).toBe(false);
    expect(await capabilityFor(vendor).has("vendor")).toBe(false);
  });
});
