import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { PHI_CORE_ROLE_PROVIDER_ID } from "@/lib/authorization";
import { PhiBaseRole } from "@/lib/constants/phi-base-roles";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  enablePhiTestAddonForSite,
  activatePhiTestAddonForSite,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

const SHOP = "@pgtest/save-shop";
const BLOG = "@pgtest/save-blog";
const OFF = "@pgtest/save-off";
// Enabled for the Site, but not available on it (the snapshot below leaves it out): its roles do not count.
const DOWN = "@pgtest/save-down";

const state = vi.hoisted(() => ({ site: null as unknown, actor: 0 }));
vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteAdminOnlyApiContext: async () => ({
    context: { site: state.site, session: { userId: state.actor } },
    error: null,
  }),
}));
vi.mock("@/lib/addons/installed", () => ({
  getPhisAddonInstalledManifest: () => ({
    "@pgtest/save-shop": { enabled: true, manifest: { addonId: "@pgtest/save-shop", roles: [
      { name: "clerk", grantableBy: { siteAccess: "site-admin" } },
      { name: "manager", grantableBy: { siteAccess: "site-admin" } },
    ] } },
    "@pgtest/save-blog": { enabled: true, manifest: { addonId: "@pgtest/save-blog", roles: [
      { name: "editor", grantableBy: { role: "chief" } },
      { name: "chief", grantableBy: { siteAccess: "site-admin" } },
    ] } },
    "@pgtest/save-off": { enabled: true, manifest: { addonId: "@pgtest/save-off", roles: [
      { name: "x", grantableBy: { siteAccess: "site-admin" } },
    ] } },
    "@pgtest/save-down": { enabled: true, manifest: { addonId: "@pgtest/save-down", roles: [
      { name: "x", grantableBy: { siteAccess: "site-admin" } },
      { name: "y", grantableBy: { siteAccess: "site-admin" } },
    ] } },
  }),
}));
vi.mock("@/lib/addons/capability-snapshot", () => ({
  readAvailablePhisProviderIds: async () => new Set(["@pgtest/save-shop", "@pgtest/save-blog"]),
}));

import { PUT, GET } from "@/app/api/site/admin/users/route";
import { saveSiteUser } from "./user-admin-save";

/**
 * Saving a Site user together with the Add-on roles of every Add-on the Site runs: one transaction, so a
 * refused or failed part leaves the person exactly as they were.
 */
describe("Saving a user with Add-on roles", () => {
  let site: PhiTestSite;
  let admin: number;
  let chiefless: number;

  const makeAdmin = async (userId: number) => (await requirePhiTestDatabase()).query(
    `INSERT INTO phis.user_site_role_claims (user_id, site_id, provider_id, role_flags) VALUES ($1, $2, $3, $4)`,
    [userId, site.id, PHI_CORE_ROLE_PROVIDER_ID, PhiBaseRole.Admin],
  );
  const put = (body: Record<string, unknown>) => PUT(new NextRequest("https://server.test/api/site/admin/users", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const grantRow = async (userId: number, addonId: string, role: string) => (await requirePhiTestDatabase()).query(
    `INSERT INTO phis.site_addon_user_roles (site_id, addon_id, user_id, role) VALUES ($1, $2, $3, $4)`,
    [site.id, addonId, userId, role],
  );
  const held = async (userId: number) => (await (await requirePhiTestDatabase()).query<{ addon_id: string; role: string }>(
    `SELECT addon_id, role FROM phis.site_addon_user_roles WHERE site_id = $1 AND user_id = $2 ORDER BY addon_id, role`,
    [site.id, userId],
  )).rows.map((row) => `${row.addon_id}:${row.role}`);
  const revision = async (userId: number) => (await (await requirePhiTestDatabase()).query<{ authorization_revision: number }>(
    `SELECT authorization_revision FROM phis.user_site_memberships WHERE user_id = $1 AND site_id = $2`,
    [userId, site.id],
  )).rows[0]!.authorization_revision;
  const emailOf = async (userId: number) => (await (await requirePhiTestDatabase()).query<{ email_normalized: string }>(
    `SELECT email_normalized FROM phis.user_emails WHERE user_id = $1`, [userId])).rows[0]!.email_normalized;
  const nameOf = async (userId: number) => (await (await requirePhiTestDatabase()).query<{ first_name: string }>(
    `SELECT first_name FROM phis.user_profiles WHERE user_id = $1`, [userId])).rows[0]?.first_name ?? null;
  async function person() {
    const userId = await createPhiTestUser(site);
    await (await requirePhiTestDatabase()).query(
      `INSERT INTO phis.user_profiles (user_id, first_name, last_name) VALUES ($1, 'Before', 'Person')`, [userId]);
    return userId;
  }
  const form = async (userId: number, patch: Record<string, unknown> = {}) => ({
    userId, email: await emailOf(userId), firstName: "After", lastName: "Person", ...patch,
  });

  beforeAll(async () => {
    site = await createPhiTestSite("user-save");
    state.site = { id: site.id, key: site.key, defaultLocale: "en" };
    admin = await createPhiTestUser(site);
    await makeAdmin(admin);
    chiefless = await createPhiTestUser(site);
    await makeAdmin(chiefless);
    await enablePhiTestAddonForSite(site, SHOP);
    await enablePhiTestAddonForSite(site, BLOG);
    // Installed, but not switched on for this Site.
    await activatePhiTestAddonForSite(site, OFF);
    await enablePhiTestAddonForSite(site, DOWN);
  });
  beforeEach(() => { state.actor = admin; });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.site_addon_user_roles WHERE addon_id = ANY($1::text[])`, [[SHOP, BLOG, OFF, DOWN]]);
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = ANY($1::text[])`, [[SHOP, BLOG, OFF, DOWN]]);
    await closePhiTestPool();
  });

  it("leaves the Add-on roles alone when the field is absent", async () => {
    const userId = await person();
    await grantRow(userId, SHOP, "clerk");
    const before = await revision(userId);

    const response = await put(await form(userId));

    expect(response.status).toBe(200);
    expect(await nameOf(userId)).toBe("After");
    expect(await held(userId)).toEqual([`${SHOP}:clerk`]);
    expect(await revision(userId)).toBe(before);
  });

  it("sets and takes back roles over several Add-ons, leaves the unseen ones, bumps the revision once, answers addonRoles", async () => {
    const userId = await person();
    await grantRow(userId, SHOP, "clerk");
    await grantRow(userId, SHOP, "retired");
    await grantRow(userId, OFF, "x");
    const before = await revision(userId);

    const response = await put(await form(userId, {
      addonRoles: [`${SHOP}:manager`, `${BLOG}:editor`],
    }));

    expect(response.status).toBe(200);
    // clerk taken back, manager and editor given; `retired` (no longer declared) and the switched-off Add-on's `x` stay.
    expect(await held(userId)).toEqual([`${BLOG}:editor`, `${OFF}:x`, `${SHOP}:manager`, `${SHOP}:retired`]);
    expect(await revision(userId)).toBe(before + 1);
    // The answer is the row as GET lists it: the stored roles that count here (no `x`: its Add-on is not available).
    expect((await response.json()).addonRoles).toEqual([`${BLOG}:editor`, `${SHOP}:manager`]);
    const single = await GET(new NextRequest(`https://server.test/api/site/admin/users?userId=${userId}`));
    expect((await single.json()).user.addonRoles).toEqual([`${BLOG}:editor`, `${SHOP}:manager`]);
  });

  it("leaves the stored roles of an Add-on enabled but not available as they are, through every save", async () => {
    const userId = await person();
    await grantRow(userId, SHOP, "clerk");
    await grantRow(userId, DOWN, "x");
    const before = await revision(userId);

    // What a client is shown, sent back unchanged: nothing moves.
    const single = await GET(new NextRequest(`https://server.test/api/site/admin/users?userId=${userId}`));
    const shown = (await single.json()).user.addonRoles;
    expect(shown).toEqual([`${SHOP}:clerk`]);
    const unchanged = await put(await form(userId, { addonRoles: shown }));
    expect(unchanged.status).toBe(200);
    expect(await held(userId)).toEqual([`${DOWN}:x`, `${SHOP}:clerk`]);
    expect(await revision(userId)).toBe(before);

    // Giving and taking back what counts still works, around the role that does not.
    const changed = await put(await form(userId, { addonRoles: [`${SHOP}:manager`] }));
    expect(changed.status).toBe(200);
    expect((await changed.json()).addonRoles).toEqual([`${SHOP}:manager`]);
    expect(await held(userId)).toEqual([`${DOWN}:x`, `${SHOP}:manager`]);
    expect(await revision(userId)).toBe(before + 1);

    expect((await put(await form(userId, { addonRoles: [] }))).status).toBe(200);
    expect(await held(userId)).toEqual([`${DOWN}:x`]);

    // Naming one of its roles is refused like an Add-on the Site does not run, and stores nothing.
    const refused = await put(await form(userId, { addonRoles: [`${SHOP}:clerk`, `${DOWN}:y`] }));
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "addon_unknown", addonId: DOWN, role: "y" });
    expect(await held(userId)).toEqual([`${DOWN}:x`]);
  });

  it("empties every role of every Add-on the Site runs with an empty list", async () => {
    const userId = await person();
    await grantRow(userId, SHOP, "manager");
    await grantRow(userId, BLOG, "editor");

    expect((await put(await form(userId, { addonRoles: [] }))).status).toBe(200);

    expect(await held(userId)).toEqual([]);
  });

  it("refuses a role of an Add-on that is switched off, unknown or not declared, and stores nothing of the person", async () => {
    const userId = await person();
    await grantRow(userId, SHOP, "clerk");
    const before = await revision(userId);

    for (const [entry, error] of [
      [`${OFF}:x`, "addon_unknown"],
      [`@pgtest/nonesuch:x`, "addon_unknown"],
      [`${SHOP}:nonesuch`, "role_undeclared"],
    ] as const) {
      const response = await put(await form(userId, { addonRoles: [`${SHOP}:manager`, entry] }));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error });
    }
    expect((await put(await form(userId, { addonRoles: "not a list" }))).status).toBe(400);
    expect((await put(await form(userId, { addonRoles: [{ addonId: SHOP, role: "manager" }] }))).status).toBe(400);

    expect(await nameOf(userId)).toBe("Before");
    expect(await held(userId)).toEqual([`${SHOP}:clerk`]);
    expect(await revision(userId)).toBe(before);
  });

  it("stores nothing, the person included, when the actor may not give one role of the difference", async () => {
    // `editor` of the blog is the chief's to give; this actor is not an admin and holds no `chief`.
    const actor = await createPhiTestUser(site);
    state.actor = actor;
    const userId = await person();
    await grantRow(userId, SHOP, "clerk");

    const response = await put(await form(userId, { addonRoles: [`${BLOG}:editor`, `${SHOP}:clerk`] }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_permitted", addonId: BLOG, role: "editor" });
    expect(await nameOf(userId)).toBe("Before");
    expect(await held(userId)).toEqual([`${SHOP}:clerk`]);
  });

  it("stores nothing of the roles when the person's own write fails: the address is taken", async () => {
    const userId = await person();
    const otherId = await person();
    await grantRow(userId, SHOP, "clerk");
    const before = await revision(userId);

    await expect(saveSiteUser({
      siteId: site.id, userId, actorUserId: admin,
      account: { newEmail: await emailOf(otherId), firstName: "After", lastName: "Person", displayName: undefined, companyName: null },
      coreRoleFlags: PhiBaseRole.Admin, enabled: false, passwordReset: null,
      addonRoles: { grant: [{ addonId: SHOP, role: "manager" }], revoke: [{ addonId: SHOP, role: "clerk" }] },
    })).rejects.toThrow("EMAIL_TAKEN");

    expect(await held(userId)).toEqual([`${SHOP}:clerk`]);
    expect(await nameOf(userId)).toBe("Before");
    expect(await revision(userId)).toBe(before);
  });

  it("stores nothing of the person when the roles' own write fails", async () => {
    const userId = await person();
    const pool = await requirePhiTestDatabase();
    await grantRow(userId, SHOP, "clerk");
    const before = await revision(userId);
    // An Add-on that is not installed breaks the foreign key of the role row, after the person was written.
    await expect(saveSiteUser({
      siteId: site.id, userId, actorUserId: admin,
      account: { newEmail: null, firstName: "After", lastName: "Person", displayName: undefined, companyName: null },
      coreRoleFlags: PhiBaseRole.Admin, enabled: false, passwordReset: null,
      addonRoles: { grant: [{ addonId: "@pgtest/never-installed", role: "x" }], revoke: [{ addonId: SHOP, role: "clerk" }] },
    })).rejects.toThrow();

    expect(await nameOf(userId)).toBe("Before");
    expect(await held(userId)).toEqual([`${SHOP}:clerk`]);
    expect(await revision(userId)).toBe(before);
    const flags = (await pool.query<{ user_site_flags: number }>(
      `SELECT user_site_flags FROM phis.user_site_memberships WHERE user_id = $1 AND site_id = $2`, [userId, site.id])).rows[0]!;
    expect(flags.user_site_flags).toBe(0);
  });

  it("lets a Site Admin set the Add-on roles of their own account, and still not their Core role", async () => {
    state.actor = chiefless;
    const own = await put(await form(chiefless, { addonRoles: [`${SHOP}:clerk`] }));
    expect(own.status).toBe(200);
    expect(await held(chiefless)).toEqual([`${SHOP}:clerk`]);

    const core = await put(await form(chiefless, { roles: [] }));
    expect(core.status).toBe(403);
  });
});
