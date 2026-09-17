import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
  PhisSiteThreadKindFlag,
  PhisThreadKind,
  PhisThreadMessageFlag,
  PhisThreadStatus,
} from "@phis/contracts/threads";
import { PhiBaseRole } from "@phis/contracts/access";

import {
  addPhiTestGroupMember,
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  addThreadMessage,
  addThreadParticipants,
  createThread,
  getThreadDetail,
  listThreadsForUser,
  markThreadRead,
  setThreadStatus,
} from "./threads";
import { buildPhisAddonThreadsCapability } from "@/lib/addons/threads-capability";

/**
 * Threads as the three readers reach them: a person, an Add-on acting for one, and an Add-on acting for
 * nobody. Every rule here is one PostgreSQL decides and a unit test would have to reimplement -- the
 * group that resolves at read time, the Site flag that decides whether a kind exists at all, and the
 * link that is the whole of an actorless Add-on's reach.
 */

const ADDON_ID = "@probe/threads";

async function offerAllThreadKinds(site: PhiTestSite) {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.site_thread_config (site_id, flags)
     VALUES ($1, $2)
     ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags`,
    [
      site.id,
      PhisSiteThreadKindFlag.Direct
      | PhisSiteThreadKindFlag.Group
      | PhisSiteThreadKindFlag.CrossGroup
      | PhisSiteThreadKindFlag.Support,
    ],
  );
}

async function grantCoreRole(site: PhiTestSite, userId: number, roleFlags: number) {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.user_site_role_claims (site_id, user_id, provider_id, role_flags)
     VALUES ($1, $2, '@phis/server/core', $3)
     ON CONFLICT (site_id, user_id, provider_id) DO UPDATE SET role_flags = EXCLUDED.role_flags`,
    [site.id, userId, roleFlags],
  );
}

async function linkAddonToThread(site: PhiTestSite, threadId: number, userId: number) {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.resource_links (
       site_id, thread_id, provider_id, type, external_id, flags, created_by_user_id
     ) VALUES ($1, $2, $3, 20, 'issue-1', 1, $4)`,
    [site.id, threadId, ADDON_ID, userId],
  );
}

describe("threads", () => {
  beforeAll(async () => {
    await dropPhiTestSites();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("offers nothing until the Site declares the kind", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-kinds");
    const author = await createPhiTestUser(site);
    const recipient = await createPhiTestUser(site);

    await expect(createThread({
      siteId: site.id,
      kind: PhisThreadKind.Direct,
      message: "Nobody offers this yet.",
      participantUserIds: [recipient],
      createdByUserId: author,
    })).rejects.toThrow(/does not offer threads of this kind/u);
  });

  it("resolves a group participant when the thread is read, not when it is named", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-group");
    await offerAllThreadKinds(site);
    const author = await createPhiTestUser(site);
    const early = await createPhiTestUser(site);
    const late = await createPhiTestUser(site);
    const stranger = await createPhiTestUser(site);
    const group = await createPhiTestGroup(site, "pgtest-threads-group");
    await addPhiTestGroupMember({ site, groupId: group, userId: author });
    await addPhiTestGroupMember({ site, groupId: group, userId: early });

    const opened = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Group,
      subject: "Group business",
      message: "Anyone here?",
      participantGroupIds: [group],
      createdByUserId: author,
    });

    expect(await getThreadDetail(site.id, { kind: "user", userId: early }, opened.thread.id))
      .not.toBeNull();
    expect(await getThreadDetail(site.id, { kind: "user", userId: late }, opened.thread.id))
      .toBeNull();

    // Joining the group joins the conversation: nothing about the thread changes.
    await addPhiTestGroupMember({ site, groupId: group, userId: late });
    expect(await getThreadDetail(site.id, { kind: "user", userId: late }, opened.thread.id))
      .not.toBeNull();
    expect(await getThreadDetail(site.id, { kind: "user", userId: stranger }, opened.thread.id))
      .toBeNull();
  });

  it("withholds an internal note from everyone but Staff", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-internal");
    await offerAllThreadKinds(site);
    const supporter = await createPhiTestUser(site);
    const customer = await createPhiTestUser(site);
    await grantCoreRole(site, supporter, PhiBaseRole.Supporter);

    const opened = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Support,
      subject: "Something broke",
      message: "It broke.",
      participantUserIds: [customer, supporter],
      requesterUserId: customer,
      createdByUserId: customer,
    });

    await addThreadMessage({
      siteId: site.id,
      threadId: opened.thread.id,
      reader: { kind: "user", userId: supporter },
      message: "Looks like the payment provider again.",
      messageFlags: PhisThreadMessageFlag.Internal,
    });

    const asStaff = await getThreadDetail(site.id, { kind: "user", userId: supporter }, opened.thread.id);
    const asCustomer = await getThreadDetail(site.id, { kind: "user", userId: customer }, opened.thread.id);
    expect(asStaff?.messages).toHaveLength(2);
    expect(asCustomer?.messages).toHaveLength(1);

    // A customer may not write one either, whatever they ask for.
    await addThreadMessage({
      siteId: site.id,
      threadId: opened.thread.id,
      reader: { kind: "user", userId: customer },
      message: "Any news?",
      messageFlags: PhisThreadMessageFlag.Internal,
    });
    const afterCustomer = await getThreadDetail(
      site.id,
      { kind: "user", userId: customer },
      opened.thread.id,
    );
    expect(afterCustomer?.messages).toHaveLength(2);
  });

  it("tracks unread against the newest message", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-unread");
    await offerAllThreadKinds(site);
    const author = await createPhiTestUser(site);
    const reader = await createPhiTestUser(site);

    const opened = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Direct,
      message: "First.",
      participantUserIds: [reader],
      createdByUserId: author,
    });

    const unread = await listThreadsForUser(site.id, reader, { unreadOnly: true });
    expect(unread.rows.map((thread) => thread.id)).toContain(opened.thread.id);

    expect(await markThreadRead(site.id, reader, opened.thread.id)).toBe(true);
    const afterRead = await listThreadsForUser(site.id, reader, { unreadOnly: true });
    expect(afterRead.rows.map((thread) => thread.id)).not.toContain(opened.thread.id);

    await addThreadMessage({
      siteId: site.id,
      threadId: opened.thread.id,
      reader: { kind: "user", userId: author },
      message: "Second.",
    });
    const afterReply = await listThreadsForUser(site.id, reader, { unreadOnly: true });
    expect(afterReply.rows.map((thread) => thread.id)).toContain(opened.thread.id);
  });

  it("archives for everyone and refuses new messages", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-archive");
    await offerAllThreadKinds(site);
    const author = await createPhiTestUser(site);
    const other = await createPhiTestUser(site);

    const opened = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Direct,
      message: "Settled.",
      participantUserIds: [other],
      createdByUserId: author,
    });

    expect(await setThreadStatus({
      siteId: site.id,
      threadId: opened.thread.id,
      reader: { kind: "user", userId: author },
      status: PhisThreadStatus.Archived,
    })).toBe(true);

    const asOther = await getThreadDetail(site.id, { kind: "user", userId: other }, opened.thread.id);
    expect(asOther?.thread.status).toBe(PhisThreadStatus.Archived);

    await expect(addThreadMessage({
      siteId: site.id,
      threadId: opened.thread.id,
      reader: { kind: "user", userId: other },
      message: "One more thing.",
    })).rejects.toThrow(/archived/u);
  });

  it("brings people in without letting them read what came before they could be seen", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-participants");
    await offerAllThreadKinds(site);
    const author = await createPhiTestUser(site);
    const first = await createPhiTestUser(site);
    const second = await createPhiTestUser(site);

    const opened = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Direct,
      message: "Just us.",
      participantUserIds: [first],
      createdByUserId: author,
    });
    expect(await getThreadDetail(site.id, { kind: "user", userId: second }, opened.thread.id))
      .toBeNull();

    const widened = await addThreadParticipants({
      siteId: site.id,
      threadId: opened.thread.id,
      reader: { kind: "user", userId: author },
      participantUserIds: [second],
    });
    expect(widened?.participants).toHaveLength(3);
    expect(await getThreadDetail(site.id, { kind: "user", userId: second }, opened.thread.id))
      .not.toBeNull();
  });

  it("bounds an Add-on by its actor", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-capability");
    await offerAllThreadKinds(site);
    const actor = await createPhiTestUser(site);
    const recipient = await createPhiTestUser(site);
    const outsider = await createPhiTestUser(site);

    const asActor = buildPhisAddonThreadsCapability({ addonId: ADDON_ID, siteId: site.id, actorUserId: actor });
    const opened = await asActor.create({
      kind: PhisThreadKind.Direct,
      subject: "From an Add-on",
      message: "Hello from a handler.",
      participantUserIds: [recipient],
    });
    expect(opened.thread.subject).toBe("From an Add-on");
    expect((await asActor.list()).map((thread) => thread.id)).toContain(opened.thread.id);

    const asOutsider = buildPhisAddonThreadsCapability({
      addonId: ADDON_ID,
      siteId: site.id,
      actorUserId: outsider,
    });
    expect(await asOutsider.get(opened.thread.id)).toBeNull();
    expect(await asOutsider.setStatus({
      threadId: opened.thread.id,
      status: PhisThreadStatus.Archived,
    })).toBe(false);
  });

  it("gives an actorless Add-on what it owns, what it is linked to, and no listing", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-actorless");
    await offerAllThreadKinds(site);
    const person = await createPhiTestUser(site);
    const recipient = await createPhiTestUser(site);

    const asJob = buildPhisAddonThreadsCapability({ addonId: ADDON_ID, siteId: site.id, actorUserId: null });

    const owned = await asJob.create({
      kind: PhisThreadKind.Group,
      message: "A job reporting an outside event.",
      participantUserIds: [recipient],
      externalRef: "delivery-1",
      externalAuthor: { name: "octocat", url: "https://example.invalid/octocat" },
    });
    expect(owned.thread.id).toBeGreaterThan(0);
    expect(owned.messages[0]?.author).toMatchObject({ kind: "integration", externalName: "octocat" });

    // The same delivery twice writes one message.
    const again = await asJob.reply({
      threadId: owned.thread.id,
      message: "A job reporting an outside event.",
      externalRef: "delivery-1",
    });
    expect(again?.messages).toHaveLength(1);

    expect((await asJob.findByExternalRef("delivery-1"))?.thread.id).toBe(owned.thread.id);
    await expect(asJob.list()).rejects.toThrow(/no acting user/u);

    // A thread a person opened is out of reach until that person links it.
    const theirs = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Direct,
      message: "Between us.",
      participantUserIds: [recipient],
      createdByUserId: person,
    });
    expect(await asJob.get(theirs.thread.id)).toBeNull();

    await linkAddonToThread(site, theirs.thread.id, person);
    expect(await asJob.get(theirs.thread.id)).not.toBeNull();
    expect(await asJob.reply({ threadId: theirs.thread.id, message: "Mirrored back." }))
      .not.toBeNull();
  });

  it("withholds a confidential message from an Add-on and keeps it for people", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-confidential");
    await offerAllThreadKinds(site);
    const person = await createPhiTestUser(site);
    const recipient = await createPhiTestUser(site);

    const opened = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Direct,
      message: "The password is hunter2.",
      messageFlags: PhisThreadMessageFlag.Confidential,
      participantUserIds: [recipient],
      createdByUserId: person,
    });

    await linkAddonToThread(site, opened.thread.id, person);
    const asJob = buildPhisAddonThreadsCapability({ addonId: ADDON_ID, siteId: site.id, actorUserId: null });
    const seen = await asJob.get(opened.thread.id);

    expect(seen?.messages[0]?.bodyText).toBeNull();
    expect((seen?.messages[0]?.flags ?? 0) & PhisThreadMessageFlag.Confidential).not.toBe(0);

    const asPerson = await getThreadDetail(site.id, { kind: "user", userId: recipient }, opened.thread.id);
    expect(asPerson?.messages[0]?.bodyText).toBe("The password is hunter2.");
  });
});
