import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPhisAddonCapabilities } from "@/lib/addons/capabilities";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import { grantPhisAddonUserRole } from "./server-addon-roles.mts";
import { ensurePhisAddonSiteGroups } from "./server-addon-groups.mts";
import { getPool } from "@/lib/db";
import { PhiUserAccountFlag } from "@/lib/constants/user-account-flags";
import { USER_SITE_FLAG_DISABLED } from "@/lib/user-site-flags";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { PhisAddonManifestV1 } from "@/lib/addons/contract";

/**
 * An Add-on making groups of its own.
 *
 * The declared list in a manifest is for the groups a Site always has, known when the manifest was
 * written. This is the other kind: one per vendor, per team, per tenant, whose number and names nobody
 * knew in advance. Two things keep it from being "a package may hand out standing" -- the manifest has
 * to ask for the writer, and the acting user has to meet the policy it states, neither of which the
 * running code can rewrite.
 */

const ADDON = "@pgtest/groupwriter";
const OTHER = "@pgtest/groupwriter-other";

function manifestWith(groupWriter: unknown): PhisAddonManifestV1 {
  return {
    manifestVersion: 1,
    addonId: ADDON,
    packageName: ADDON,
    packageVersion: "0.1.0",
    serverAbi: "1",
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: ["@phis/server/groups:v1"],
    apiRoutes: [],
    hooks: [],
    jobs: [],
    settings: [],
    roles: [{ name: "curator", description: "Runs it.", grantableBy: { siteAccess: "site-admin" } }],
    groups: [{ key: "staff", name: "Staff" }],
    schema: null,
    queries: null,
    migrationVersion: 1,
    ...(groupWriter === null ? {} : { groupWriter }),
  } as unknown as PhisAddonManifestV1;
}

describe("an Add-on that makes its own groups", () => {
  let site: PhiTestSite;
  let curator: number;
  let plain: number;
  let member: number;

  function groups(actorUserId: number | null, groupWriter: unknown = { allowedBy: { role: "curator" } }) {
    return buildPhisAddonCapabilities({
      manifest: manifestWith(groupWriter),
      manifestDigest: "pgtest-groupwriter",
      siteId: site.id,
      siteKey: site.key,
      actorUserId,
    }).groups!;
  }

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-groupwriter");
    curator = await createPhiTestUser(site);
    plain = await createPhiTestUser(site);
    member = await createPhiTestUser(site);
    for (const addonId of [ADDON, OTHER]) {
      await pool.query(
        `INSERT INTO phis.server_addons
           (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
         VALUES ($1, $1, '0.1.0', '1', repeat('0', 64), 'pgtest')
         ON CONFLICT (addon_id) DO NOTHING`,
        [addonId],
      );
    }
    await grantPhisAddonUserRole(pool, {
      addonId: ADDON, siteId: site.id, userId: curator, role: "curator", grantedByUserId: curator,
    });
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.site_groups WHERE provider_id = ANY($1::varchar[])`,
      [[ADDON, OTHER]]);
    await pool.query(`DELETE FROM phis.site_addon_user_roles WHERE addon_id = $1`, [ADDON]);
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = ANY($1::varchar[])`,
      [[ADDON, OTHER]]);
    await closePhiTestPool();
  });

  it("makes a group and hands back the id the database assigned", async () => {
    const group = await groups(curator).create({ key: "vendor-acme", name: "Acme GmbH" });
    expect(group).toMatchObject({ key: "vendor-acme", name: "Acme GmbH" });
    expect(group.id).toBeGreaterThan(0);

    // Asking again is the way to learn an id: the key is the Add-on's, the id is the database's.
    expect((await groups(curator).create({ key: "vendor-acme", name: "Acme GmbH" })).id)
      .toBe(group.id);
    // And it carries this Add-on as its provider, which is what every write checks afterwards.
    const { rows } = await getPool().query<{ provider_id: string }>(
      `SELECT provider_id FROM phis.site_groups WHERE id = $1`, [group.id],
    );
    expect(rows[0]!.provider_id).toBe(ADDON);
  });

  it("refuses where the manifest never asked for a writer", async () => {
    await expect(groups(curator, null).create({ key: "vendor-nope", name: "Nope" }))
      .rejects.toThrow(/declares no groupWriter/);
  });

  it("refuses somebody the declared policy does not admit", async () => {
    // The policy is the manifest's and the evaluation is Core's, which is what keeps "an Add-on defines
    // its own groups" from becoming "an Add-on fills them with whoever asks".
    await expect(groups(plain).create({ key: "vendor-plain", name: "Plain" }))
      .rejects.toThrow(/does not meet the policy/);
  });

  it("puts somebody in, at the level it was given", async () => {
    const group = await groups(curator).create({ key: "vendor-members", name: "Members" });
    expect(await groups(curator).addMember({
      groupId: group.id, userId: member, level: "author",
    })).toBe(true);

    const { rows } = await getPool().query<{ membership_flags: number; source_provider_id: string }>(
      `SELECT membership_flags, source_provider_id FROM phis.site_group_members
        WHERE group_id = $1 AND user_id = $2`,
      [group.id, member],
    );
    // The level crossed by name and is stored as the bits Core keeps: an Add-on never sees them.
    expect(rows[0]).toMatchObject({
      membership_flags: PhiGroupMembershipFlags.Author,
      source_provider_id: ADDON,
    });

    expect(await groups(curator).removeMember({ groupId: group.id, userId: member })).toBe(true);
    const { rows: after } = await getPool().query(
      `SELECT 1 FROM phis.site_group_members WHERE group_id = $1 AND user_id = $2`,
      [group.id, member],
    );
    expect(after).toHaveLength(0);
  });

  it("refuses somebody whose membership or account is disabled", async () => {
    // A membership for somebody who cannot sign in here grants nothing now and would come back to
    // life the day the account is enabled again.
    const group = await groups(curator).create({ key: "vendor-disabled", name: "Disabled" });
    const siteDisabled = await createPhiTestUser(site);
    await getPool().query(
      `UPDATE phis.user_site_memberships SET user_site_flags = user_site_flags | $3
        WHERE site_id = $1 AND user_id = $2`,
      [site.id, siteDisabled, USER_SITE_FLAG_DISABLED],
    );
    const accountDisabled = await createPhiTestUser(site);
    await getPool().query(
      `UPDATE phis.user_accounts SET flags = flags | $2 WHERE id = $1`,
      [accountDisabled, PhiUserAccountFlag.Disabled],
    );
    for (const userId of [siteDisabled, accountDisabled]) {
      await expect(groups(curator).addMember({ groupId: group.id, userId, level: "member" }))
        .rejects.toThrow(/not an active member/);
    }
  });

  it("leaves the groups the manifest declares to the Site", async () => {
    // Declared groups are the Site's to fill; a writer below its administrators must not reach them.
    const [declared] = await ensurePhisAddonSiteGroups(getPool(), {
      addonId: ADDON, siteId: site.id, declared: [{ key: "staff", name: "Staff" }],
    });
    await expect(groups(curator).create({ key: "staff", name: "Renamed" }))
      .rejects.toThrow(/the manifest declares/);
    await expect(groups(curator).addMember({ groupId: declared!.groupId, userId: member, level: "member" }))
      .rejects.toThrow(/declared in the manifest/);
    await expect(groups(curator).retire({ groupId: declared!.groupId })).rejects.toThrow(/declared in the manifest/);
    const { rows } = await getPool().query<{ name: string }>(
      `SELECT name FROM phis.site_groups WHERE id = $1`, [declared!.groupId],
    );
    expect(rows[0]!.name).toBe("Staff");
  });

  it("refuses a group belonging to another Add-on", async () => {
    /*
     * The rule the whole writer rests on. Group ids are integers from one table, so without this an
     * Add-on could administer Core's groups and another Add-on's by guessing a number.
     */
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.site_groups (site_id, provider_id, key, name)
       VALUES ($1, $2, 'theirs', 'Theirs') RETURNING id`,
      [site.id, OTHER],
    );
    const foreign = rows[0]!.id;

    await expect(groups(curator).addMember({
      groupId: foreign, userId: member, level: "member",
    })).rejects.toThrow(/not @pgtest\/groupwriter's to administer/);
    await expect(groups(curator).retire({ groupId: foreign })).rejects.toThrow(/to administer/);
  });

  it("retires its own, and a retired group stops being one it administers", async () => {
    const group = await groups(curator).create({ key: "vendor-gone", name: "Gone" });
    expect(await groups(curator).retire({ groupId: group.id })).toBe(true);
    // Retirement is not deletion: the row and its key stay, so a later group cannot inherit its policies.
    const { rows } = await getPool().query<{ retired_at: string | null }>(
      `SELECT retired_at FROM phis.site_groups WHERE id = $1`, [group.id],
    );
    expect(rows[0]!.retired_at).not.toBeNull();
    await expect(groups(curator).addMember({
      groupId: group.id, userId: member, level: "member",
    })).rejects.toThrow(/to administer/);
  });
});
