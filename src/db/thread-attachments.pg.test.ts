import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PhiBaseRole } from "@phis/contracts/access";
import { PhiMediaDeliveryPolicy } from "@phis/contracts/media";
import { PhisSiteThreadKindFlag, PhisThreadKind, PhisThreadMessageFlag } from "@phis/contracts/threads";

import { PhiSiteGroupFlags } from "@/lib/constants/site-groups";

import {
  addPhiTestGroupMember,
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  enablePhiTestAddonForSite,
  requirePhiTestDatabase,
  setPhiTestMediaConfig,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  PhisThreadAttachmentError,
  addThreadMessage,
  countThreadAttachmentsForAsset,
  createThread,
  getThreadDetail,
  readThreadMessageAsset,
} from "./threads";

const configured = process.env.PHIS_PG_TEST === "1";

/**
 * An attachment is readable by whoever may read the message it hangs on. That is the whole rule, and
 * these are the cases that would break it if the audience came from custody instead: a file in one
 * person's Space, read by somebody else in the same conversation, and withheld from that same person on
 * an `Internal` note beside it.
 */
describe.skipIf(!configured)("thread attachments", () => {
  let site: PhiTestSite;
  let requester: number;
  let supporter: number;
  let groupId: number;

  /** A file of this user's own, in their own User Space -- which is the only place they may write. */
  async function uploadInto(userId: number, name: string) {
    const pool = await requirePhiTestDatabase();
    const spaces = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_spaces (site_id, kind, user_id, default_storage_profile_id)
       VALUES ($1, 2, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [site.id, userId, site.storageProfileId],
    );
    const spaceId = spaces.rows[0]?.id ?? (await pool.query<{ id: number }>(
      `SELECT id FROM phis.media_spaces WHERE site_id = $1 AND kind = 2 AND user_id = $2`,
      [site.id, userId],
    )).rows[0]!.id;
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_assets
         (site_id, space_id, storage_profile_id, storage_key, original_name, content_type,
          bytes, lifecycle_status, delivery_policy, owner_user_id, created_by_user_id)
       SELECT $1, $2, space.default_storage_profile_id, $3, $4, 'text/plain',
              12, 2, $5, $6, $6
       FROM phis.media_spaces space WHERE space.id = $2
       RETURNING id`,
      [site.id, spaceId, `k/${name}`, name, PhiMediaDeliveryPolicy.Public, userId],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("thread-attach");
    await pool.query(
      `INSERT INTO phis.site_thread_config (site_id, flags) VALUES ($1, $2)
       ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags`,
      [site.id, PhisSiteThreadKindFlag.Support | PhisSiteThreadKindFlag.Group],
    );
    await setPhiTestMediaConfig(site, {});
    requester = await createPhiTestUser(site);
    supporter = await createPhiTestUser(site);
    groupId = await createPhiTestGroup(site, "pgtest-attach");
    await addPhiTestGroupMember({ site, groupId, userId: supporter });
    // The threads here are the group's, so the one who opens them is its Author and the group holds
    // threads; what is under test is whose file may hang on a message, not who may open one.
    await addPhiTestGroupMember({ site, groupId, userId: requester, membershipFlags: 3 });
    await pool.query(
      `UPDATE phis.site_groups SET flags = $2 WHERE id = $1`,
      [groupId, PhiSiteGroupFlags.Threads],
    );
    // `Internal` is Staff's to write, and any Core role is what makes somebody Staff.
    await pool.query(
      `INSERT INTO phis.user_site_role_claims (site_id, user_id, provider_id, role_flags)
       VALUES ($1, $2, '@phis/server/core', $3)
       ON CONFLICT (site_id, user_id, provider_id) DO UPDATE SET role_flags = EXCLUDED.role_flags`,
      [site.id, supporter, PhiBaseRole.Supporter],
    );
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("refuses a file that is not the writer's own", async () => {
    const someoneElses = await uploadInto(supporter, "theirs.txt");
    await expect(createThread({
      siteId: site.id,
      kind: PhisThreadKind.Group,
      message: "not mine to attach",
      participantGroupIds: [groupId],
      createdByUserId: requester,
      assetIds: [someoneElses],
    })).rejects.toThrow(PhisThreadAttachmentError);
  });

  it("hands the file to everyone who may read the message, whoever owns the bytes", async () => {
    const log = await uploadInto(requester, "fault.log");
    const thread = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Group,
      subject: "The export fails",
      message: "Here is the log.",
      participantUserIds: [requester],
      participantGroupIds: [groupId],
      createdByUserId: requester,
      assetIds: [log],
    });

    const seenByStaff = await getThreadDetail(site.id, { kind: "user", userId: supporter }, thread.thread.id);
    // The bytes sit in the requester's own Space. The Supporter reads them anyway, because the message
    // is what decides and the Space only says who pays.
    expect(seenByStaff!.messages[0]!.assets).toHaveLength(1);
    expect(seenByStaff!.messages[0]!.assets[0]).toMatchObject({
      assetId: log,
      fileName: "fault.log",
      href: `/api/site/threads/${thread.thread.id}/messages/${seenByStaff!.messages[0]!.id}/assets/${log}`,
    });
    expect(await readThreadMessageAsset({
      siteId: site.id,
      reader: { kind: "user", userId: supporter },
      threadId: thread.thread.id,
      messageId: seenByStaff!.messages[0]!.id,
      assetId: log,
    })).not.toBeNull();
  });

  it("sets the delivery policy to Internal, so no address reaches it by its own id", async () => {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ delivery_policy: number }>(
      `SELECT asset.delivery_policy
       FROM phis.media_assets asset
       JOIN phis.thread_message_assets link ON link.asset_id = asset.id
       WHERE asset.site_id = $1 AND asset.original_name = 'fault.log'`,
      [site.id],
    );
    // It was uploaded Public. Attaching it said something else.
    expect(rows[0]!.delivery_policy).toBe(PhiMediaDeliveryPolicy.Internal);
  });

  it("withholds an Internal note's files from the person the thread is about", async () => {
    const note = await uploadInto(supporter, "triage.txt");
    const thread = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Group,
      message: "Opened.",
      participantUserIds: [requester],
      participantGroupIds: [groupId],
      createdByUserId: requester,
    });
    await addThreadMessage({
      siteId: site.id,
      threadId: thread.thread.id,
      reader: { kind: "user", userId: supporter },
      message: "Staff only.",
      messageFlags: PhisThreadMessageFlag.Internal,
      assetIds: [note],
    });

    const staffSees = await getThreadDetail(site.id, { kind: "user", userId: supporter }, thread.thread.id);
    const internal = staffSees!.messages.find((m) => (m.flags & PhisThreadMessageFlag.Internal) !== 0);
    expect(internal!.assets).toHaveLength(1);

    const requesterSees = await getThreadDetail(site.id, { kind: "user", userId: requester }, thread.thread.id);
    // Not filtered out of a list they were shown -- the message is not in their conversation at all.
    expect(requesterSees!.messages.some((m) => (m.flags & PhisThreadMessageFlag.Internal) !== 0)).toBe(false);
    // And the address is refused, so knowing the id gets nowhere either.
    expect(await readThreadMessageAsset({
      siteId: site.id,
      reader: { kind: "user", userId: requester },
      threadId: thread.thread.id,
      messageId: internal!.id,
      assetId: note,
    })).toBeNull();
  });

  it("refuses to let the owner delete a file a message still points at", async () => {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM phis.media_assets WHERE site_id = $1 AND original_name = 'fault.log'`,
      [site.id],
    );
    expect(await countThreadAttachmentsForAsset(site.id, rows[0]!.id)).toBe(1);
    // The constraint is the rule; the count is only what lets the refusal be a sentence.
    await expect(pool.query(
      `DELETE FROM phis.media_assets WHERE id = $1`,
      [rows[0]!.id],
    )).rejects.toThrow(/thread_message_assets/);
  });

  it("lets an Add-on attach from its own Space and nobody else's", async () => {
    const pool = await requirePhiTestDatabase();
    const addonId = "@phis/pgtest-attach";
    // An Add-on Space belongs to an Add-on the Site actually runs; `media_spaces_addon_fk` says so.
    await enablePhiTestAddonForSite(site, addonId);
    const spaces = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_spaces (site_id, kind, addon_id, default_storage_profile_id)
       VALUES ($1, 4, $2, $3) RETURNING id`,
      [site.id, addonId, site.storageProfileId],
    );
    const imported = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_assets
         (site_id, space_id, storage_profile_id, storage_key, original_name, content_type,
          bytes, lifecycle_status, delivery_policy)
       VALUES ($1, $2, $3, 'k/imported.png', 'imported.png', 'image/png', 12, 2, 1)
       RETURNING id`,
      [site.id, spaces.rows[0]!.id, site.storageProfileId],
    );

    const thread = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Group,
      message: "Arrived from the repository.",
      participantGroupIds: [groupId],
      // No actor: the thread is the Add-on's own, and so is the file it hangs on it.
      ownerProviderId: addonId,
      assetIds: [imported.rows[0]!.id],
    });
    const seen = await getThreadDetail(site.id, { kind: "provider", providerId: addonId }, thread.thread.id);
    expect(seen!.messages[0]!.assets).toHaveLength(1);

    // A person's file is not the Add-on's to attach, whatever it can read.
    const theirs = await uploadInto(requester, "not-yours.txt");
    await expect(createThread({
      siteId: site.id,
      kind: PhisThreadKind.Group,
      message: "Not mine.",
      participantGroupIds: [groupId],
      ownerProviderId: addonId,
      assetIds: [theirs],
    })).rejects.toThrow(PhisThreadAttachmentError);
  });

  it("takes the links with the message, because a link to nothing records nothing", async () => {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number; message_id: number }>(
      `SELECT asset.id, link.message_id
       FROM phis.media_assets asset
       JOIN phis.thread_message_assets link ON link.asset_id = asset.id
       WHERE asset.site_id = $1 AND asset.original_name = 'triage.txt'`,
      [site.id],
    );
    await pool.query(`DELETE FROM phis.thread_messages WHERE id = $1`, [rows[0]!.message_id]);
    expect(await countThreadAttachmentsForAsset(site.id, rows[0]!.id)).toBe(0);
  });
});
