import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addPhiTestGroupMember,
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestGroupSpace,
  createPhiTestSite,
  createPhiTestUser,
  createPhiTestUserSpace,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  createMediaAsset,
  createMediaFolder,
  deleteMediaFolderBySite,
  getMediaAssetBySiteAndId,
  getMediaFolderBySiteAndId,
  listMediaFolders,
  resolveOrCreateMediaFolderPath,
} from "./media";
import { getEffectiveUserSiteAuthorization } from "./user-site-memberships";

/**
 * The last of the fake-only matrix: Folder ownership, the delivery default an Asset inherits from the
 * Space it is created in, and the claim projection every authorization decision reads. All three are
 * decided by joins and composite keys rather than by the caller, which is what makes a fake unable to
 * tell a working one from a missing one.
 */
describe("Media Folders and authorization claims against PostgreSQL", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("folders");
    other = await createPhiTestSite("folders-other");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  describe("Folder ownership", () => {
    it("creates a Folder in the Space it was asked for and nowhere else", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      const folder = await createMediaFolder({ siteId: site.id, spaceId, name: "pgtest-owned" });

      expect(folder?.spaceId).toBe(spaceId);
      expect(await listMediaFolders(site.id, site.siteSpaceId)).toHaveLength(0);
      expect((await listMediaFolders(site.id, spaceId)).map((row) => row.id)).toEqual([folder!.id]);
    });

    it("refuses to create a Folder in another Site's Space", async () => {
      await expect(
        createMediaFolder({ siteId: site.id, spaceId: other.siteSpaceId, name: "pgtest-cross" }),
      ).rejects.toThrow();
    });

    it("does not read a Folder through the wrong Site or Space", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      const folder = await createMediaFolder({ siteId: site.id, spaceId, name: "pgtest-scoped" });

      expect(await getMediaFolderBySiteAndId(site.id, spaceId, folder!.id)).not.toBeNull();
      expect(await getMediaFolderBySiteAndId(site.id, site.siteSpaceId, folder!.id)).toBeNull();
      expect(await getMediaFolderBySiteAndId(other.id, spaceId, folder!.id)).toBeNull();
    });

    it("refuses a parent from a different Space", async () => {
      const spaceA = await createPhiTestGroupSpace(site, 1_000);
      const spaceB = await createPhiTestGroupSpace(site, 1_000);
      const parent = await createMediaFolder({ siteId: site.id, spaceId: spaceA, name: "pgtest-parent" });

      await expect(
        createMediaFolder({ siteId: site.id, spaceId: spaceB, parentId: parent!.id, name: "pgtest-child" }),
      ).rejects.toThrow();
    });

    it("resolves an existing path instead of creating a second branch", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);

      const first = await resolveOrCreateMediaFolderPath(site.id, spaceId, ["pgtest-a", "pgtest-b"]);
      const again = await resolveOrCreateMediaFolderPath(site.id, spaceId, ["pgtest-a", "pgtest-b"]);

      expect(again).toBe(first);
      expect(await listMediaFolders(site.id, spaceId)).toHaveLength(2);
    });

    // Deleting a Folder moves what it held to the Space root rather than taking it along: the FK is
    // `ON DELETE SET NULL (folder_id)`, so an Asset outlives the arrangement it happened to be filed
    // under. Custody belongs to the Space, and a Folder is only how someone arranged it.
    it("keeps an Asset when its Folder is deleted and files it at the Space root", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      const folder = await createMediaFolder({ siteId: site.id, spaceId, name: "pgtest-occupied" });
      const asset = await createMediaAsset({
        siteId: site.id, spaceId, folderId: folder!.id, storageProfileId: site.storageProfileId,
        storageKey: "pgtest/in-folder", originalName: "in-folder.png", contentType: "image/png",
      });
      expect(asset?.folderId).toBe(folder!.id);

      expect(await deleteMediaFolderBySite(site.id, spaceId, folder!.id)).toBe(true);

      const surviving = await getMediaAssetBySiteAndId(site.id, asset!.id, spaceId);
      expect(surviving).not.toBeNull();
      expect(surviving?.folderId).toBeNull();
    });

    it("does not delete a Folder through the wrong Space", async () => {
      const spaceId = await createPhiTestGroupSpace(site, 1_000);
      const folder = await createMediaFolder({ siteId: site.id, spaceId, name: "pgtest-guarded" });

      expect(await deleteMediaFolderBySite(site.id, site.siteSpaceId, folder!.id)).toBe(false);
      expect(await getMediaFolderBySiteAndId(site.id, spaceId, folder!.id)).not.toBeNull();
    });
  });

  describe("delivery default by Space", () => {
    // Policy values: 1 Public, 3 User, 4 Group. The default follows custody, so a file in an isolated
    // Space is not published by the act of arriving there.
    it("gives an Asset the policy its Space implies", async () => {
      const groupSpaceId = await createPhiTestGroupSpace(site, 1_000);
      const userSpaceId = await createPhiTestUserSpace(site, 1_000);

      const inSite = await createMediaAsset({
        siteId: site.id, spaceId: site.siteSpaceId, spaceKind: 1, storageProfileId: site.storageProfileId,
        storageKey: "pgtest/policy-site", originalName: "s.png", contentType: "image/png",
      });
      const inUser = await createMediaAsset({
        siteId: site.id, spaceId: userSpaceId, spaceKind: 2, storageProfileId: site.storageProfileId,
        storageKey: "pgtest/policy-user", originalName: "u.png", contentType: "image/png",
      });
      const inGroup = await createMediaAsset({
        siteId: site.id, spaceId: groupSpaceId, spaceKind: 3, storageProfileId: site.storageProfileId,
        storageKey: "pgtest/policy-group", originalName: "g.png", contentType: "image/png",
      });

      expect(inSite?.deliveryPolicy).toBe(1);
      expect(inUser?.deliveryPolicy).toBe(3);
      expect(inGroup?.deliveryPolicy).toBe(4);
      // Every Asset starts at delivery revision 1, which is what the immutable cache key is built from.
      expect([inSite, inUser, inGroup].map((asset) => asset?.deliveryRevision)).toEqual([1, 1, 1]);
    });
  });

  describe("claim projection", () => {
    it("grants a group claim to a member and to nobody else", async () => {
      const userId = await createPhiTestUser(site);
      const stranger = await createPhiTestUser(site);
      const groupId = await createPhiTestGroup(site, "pgtest-claims");
      await addPhiTestGroupMember({ site, groupId, userId });

      const member = await getEffectiveUserSiteAuthorization(userId, site.id);
      const outsider = await getEffectiveUserSiteAuthorization(stranger, site.id);

      expect(member.groupClaims).toHaveLength(1);
      expect(outsider.groupClaims).toHaveLength(0);
    });

    it("grants nothing once the group is retired", async () => {
      const pool = await requirePhiTestDatabase();
      const userId = await createPhiTestUser(site);
      const groupId = await createPhiTestGroup(site, "pgtest-retired");
      await addPhiTestGroupMember({ site, groupId, userId });

      await pool.query(`UPDATE phis.site_groups SET retired_at = NOW() WHERE id = $1`, [groupId]);

      expect((await getEffectiveUserSiteAuthorization(userId, site.id)).groupClaims).toHaveLength(0);
    });

    it("grants nothing once the membership has expired", async () => {
      const userId = await createPhiTestUser(site);
      const groupId = await createPhiTestGroup(site, "pgtest-expired");
      await addPhiTestGroupMember({ site, groupId, userId, validUntilSeconds: -60 });

      expect((await getEffectiveUserSiteAuthorization(userId, site.id)).groupClaims).toHaveLength(0);
    });

    it("does not carry a claim or a membership across Sites", async () => {
      const pool = await requirePhiTestDatabase();
      const userId = await createPhiTestUser(site);
      const groupId = await createPhiTestGroup(site, "pgtest-cross-site");
      await addPhiTestGroupMember({ site, groupId, userId });
      await pool.query(
        `INSERT INTO phis.user_site_role_claims (user_id, site_id, provider_id, role_flags)
         VALUES ($1, $2, '@phis/phi-server/core', 8)`,
        [userId, site.id],
      );

      const here = await getEffectiveUserSiteAuthorization(userId, site.id);
      const elsewhere = await getEffectiveUserSiteAuthorization(userId, other.id);

      expect(here.coreRoleFlags).toBe(8);
      expect(here.enabled).toBe(true);
      expect(elsewhere.coreRoleFlags).toBe(0);
      expect(elsewhere.groupClaims).toHaveLength(0);
      // No membership on the other Site at all, so the actor is not enabled there.
      expect(elsewhere.enabled).toBe(false);
    });
  });
});
