import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  grantPhisAddonUserRole,
  readPhiSiteUsersAddonRoles,
  replacePhisAddonUserRoles,
} from "./server-addon-roles.mts";
import { listAdminUsersForSite } from "./user-admin";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * Add-on roles in user administration: what the page's one read returns per Site, the filter on stored
 * grants, and the all-or-nothing replacement behind `PUT /api/site/addon-roles`.
 */

const ADDON = "@pgtest/admin-roles";
const OTHER_ADDON = "@pgtest/admin-roles-other";

describe("Add-on roles in user administration", () => {
  let site: PhiTestSite;
  let otherSite: PhiTestSite;
  let manager: number;
  let clerk: number;
  let nobody: number;
  let elsewhere: number;
  let granter: number;

  const grant = async (siteId: number, userId: number, role: string, addonId = ADDON) =>
    grantPhisAddonUserRole(await requirePhiTestDatabase(), {
      addonId, siteId, userId, role, grantedByUserId: null,
    });
  const revision = async (userId: number) => (await (await requirePhiTestDatabase()).query<{ authorization_revision: number }>(
    `SELECT authorization_revision FROM phis.user_site_memberships WHERE user_id = $1 AND site_id = $2`,
    [userId, site.id],
  )).rows[0]!.authorization_revision;
  const listIds = async (addonRoles?: { addonId: string; roles: string[] }) =>
    (await listAdminUsersForSite(site.id, { addonRoles, pageSize: 200 })).rows.map((row) => row.id);

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("admin-roles");
    otherSite = await createPhiTestSite("admin-roles-other");
    manager = await createPhiTestUser(site);
    clerk = await createPhiTestUser(site);
    nobody = await createPhiTestUser(site);
    granter = await createPhiTestUser(site);
    elsewhere = await createPhiTestUser(otherSite);
    for (const addonId of [ADDON, OTHER_ADDON]) {
      await pool.query(
        `INSERT INTO phis.server_addons
           (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
         VALUES ($1::varchar, $1::text || '-server', '1.0.0', '1', repeat('0', 64), 'pgtest')
         ON CONFLICT (addon_id) DO NOTHING`,
        [addonId],
      );
    }
    await grant(site.id, manager, "manager");
    await grant(site.id, clerk, "clerk");
    await grant(site.id, clerk, "clerk", OTHER_ADDON);
    await grant(otherSite.id, elsewhere, "manager");
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.site_addon_user_roles WHERE addon_id = ANY($1::text[])`, [[ADDON, OTHER_ADDON]]);
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = ANY($1::text[])`, [[ADDON, OTHER_ADDON]]);
    await closePhiTestPool();
  });

  it("reads the page's stored grants in one statement, for this Site only", async () => {
    const pool = await requirePhiTestDatabase();
    const byUser = await readPhiSiteUsersAddonRoles(pool, {
      siteId: site.id,
      userIds: [manager, clerk, nobody, elsewhere],
    });

    expect(byUser.get(manager)).toEqual([{ addonId: ADDON, role: "manager" }]);
    expect(byUser.get(clerk)).toEqual([
      { addonId: ADDON, role: "clerk" },
      { addonId: OTHER_ADDON, role: "clerk" },
    ]);
    expect(byUser.has(nobody)).toBe(false);
    // Granted on another Site: not this Site's to show, even when asked for by id.
    expect(byUser.has(elsewhere)).toBe(false);
    expect((await readPhiSiteUsersAddonRoles(pool, { siteId: site.id, userIds: [] })).size).toBe(0);
  });

  it("filters the list to users with a stored grant of the named roles of the Add-on", async () => {
    expect((await listIds({ addonId: ADDON, roles: ["manager", "clerk"] })).sort()).toEqual([manager, clerk].sort());
    // `manager` implies `clerk`: the role set a caller derives from `includes` finds both holders.
    expect((await listIds({ addonId: ADDON, roles: ["manager"] }))).toEqual([manager]);
    expect((await listIds({ addonId: OTHER_ADDON, roles: ["clerk"] }))).toEqual([clerk]);
  });

  it("matches nobody for no roles, another Add-on, or a user who holds the role on another Site", async () => {
    expect(await listIds({ addonId: ADDON, roles: [] })).toEqual([]);
    expect(await listIds({ addonId: "@pgtest/nonesuch", roles: ["manager"] })).toEqual([]);
    expect(await listIds({ addonId: ADDON, roles: ["manager"] })).not.toContain(elsewhere);
  });

  it("lists everybody when no Add-on filter is given, and counts only the filtered users", async () => {
    expect((await listIds()).sort()).toEqual([manager, clerk, nobody, granter].sort());
    const filtered = await listAdminUsersForSite(site.id, { addonRoles: { addonId: ADDON, roles: ["clerk"] } });
    expect(filtered.total).toBe(1);
    expect(filtered.siteTotal).toBe(4);
  });

  describe("replacing the roles of one Add-on", () => {
    it("grants and revokes the difference in one go, and moves the revision once", async () => {
      const pool = await requirePhiTestDatabase();
      const member = await createPhiTestUser(site);
      await grant(site.id, member, "clerk");
      await grant(site.id, member, "clerk", OTHER_ADDON);
      const before = await revision(member);

      const result = await replacePhisAddonUserRoles(pool, {
        addonId: ADDON, siteId: site.id, userId: member,
        grant: ["manager", "auditor"], revoke: ["clerk"], grantedByUserId: granter,
      });

      expect(result).toEqual({ granted: ["auditor", "manager"], revoked: ["clerk"] });
      expect(await revision(member)).toBe(before + 1);
      const held = (await readPhiSiteUsersAddonRoles(pool, { siteId: site.id, userIds: [member] })).get(member);
      expect(held).toEqual([
        { addonId: ADDON, role: "auditor" },
        { addonId: ADDON, role: "manager" },
        // Another Add-on's grant is not touched.
        { addonId: OTHER_ADDON, role: "clerk" },
      ]);
      const { rows } = await pool.query<{ granted_by_user_id: number }>(
        `SELECT granted_by_user_id FROM phis.site_addon_user_roles WHERE user_id = $1 AND role = 'manager'`, [member]);
      expect(rows[0]!.granted_by_user_id).toBe(granter);
    });

    it("changes nothing and moves nothing when the roles are already as asked", async () => {
      const pool = await requirePhiTestDatabase();
      const before = await revision(manager);

      expect(await replacePhisAddonUserRoles(pool, {
        addonId: ADDON, siteId: site.id, userId: manager,
        grant: ["manager"], revoke: ["clerk"], grantedByUserId: granter,
      })).toEqual({ granted: [], revoked: [] });
      expect(await revision(manager)).toBe(before);
    });

    it("writes nothing when the statement fails part-way", async () => {
      const pool = await requirePhiTestDatabase();
      const member = await createPhiTestUser(site);
      await grant(site.id, member, "clerk");
      const before = await revision(member);

      // An empty role name violates the table's check after the revoke half has been planned.
      await expect(replacePhisAddonUserRoles(pool, {
        addonId: ADDON, siteId: site.id, userId: member,
        grant: ["manager", ""], revoke: ["clerk"], grantedByUserId: granter,
      })).rejects.toThrow();

      expect((await readPhiSiteUsersAddonRoles(pool, { siteId: site.id, userIds: [member] })).get(member))
        .toEqual([{ addonId: ADDON, role: "clerk" }]);
      expect(await revision(member)).toBe(before);
    });
  });
});
