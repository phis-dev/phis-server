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
  withPhiTestClient,
  type PhiTestSite,
} from "../../test/pg/harness";
import { setSiteGroupFlags } from "./site-groups";
import {
  addThreadMessage,
  addThreadParticipants,
  createThread,
  createThreadWithDb,
  getThreadDetail,
  listThreadsForUser,
  markThreadRead,
  setThreadStatus,
} from "./threads";
import { buildPhisAddonThreadsCapability } from "@/lib/addons/threads-capability";
import { PhiSiteGroupFlags } from "@/lib/constants/site-groups";

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

/**
 * Staff who share a group: what a Direct thread takes on both ends. A person is visible to another only
 * through a group they share, and only Staff may be written to, so every fixture that opens one starts
 * from here rather than from two accounts that happen to exist on the same Site.
 */
async function createStaffWhoShareAGroup(site: PhiTestSite, key: string, count: number) {
  const group = await createPhiTestGroup(site, key);
  const users: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const userId = await createPhiTestUser(site);
    await grantCoreRole(site, userId, PhiBaseRole.Staff);
    await addPhiTestGroupMember({ site, groupId: group, userId });
    users.push(userId);
  }
  return { group, users };
}

/** A Support thread the way a ticket opens one: on the ticket's own transaction, requester and all. */
async function openSupportThread(site: PhiTestSite, input: { requester: number; supporter: number }) {
  const { id } = await withPhiTestClient((client) => createThreadWithDb(client, {
    siteId: site.id,
    kind: PhisThreadKind.Support,
    subject: "Something broke",
    message: "It broke.",
    participantUserIds: [input.requester, input.supporter],
    requesterUserId: input.requester,
    createdByUserId: input.requester,
  }));
  return id;
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
    await setSiteGroupFlags(site.id, group, PhiSiteGroupFlags.Threads);
    // Flag 3 is Member and Author; opening the group's thread is the Author's.
    await addPhiTestGroupMember({ site, groupId: group, userId: author, membershipFlags: 3 });
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

  it("names a person without a profile name by nothing, never by their address", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-names");
    await offerAllThreadKinds(site);
    const { users: [opener, colleague] } = await createStaffWhoShareAGroup(site, "pgtest-names", 2);
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.user_profiles WHERE user_id = ANY($1::int[])`, [[opener, colleague]]);

    const opened = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Direct,
      subject: "Names",
      message: "Hello.",
      participantUserIds: [colleague],
      createdByUserId: opener,
    });
    const detail = await getThreadDetail(site.id, { kind: "user", userId: colleague }, opened.thread.id);

    const participantNames = (detail?.participants ?? []).flatMap((participant) =>
      participant.kind === "user" ? [participant.user.displayName] : []);
    const authorNames = (detail?.messages ?? []).flatMap((message) =>
      message.author.kind === "user" ? [message.author.user.displayName] : []);
    expect(participantNames).toEqual([null, null]);
    expect(authorNames).toEqual([null]);
  });

  it("keeps a Direct thread to Staff who share a group, and lets an Admin reach any Staff", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-reach");
    await offerAllThreadKinds(site);
    const { users: [opener, colleague] } = await createStaffWhoShareAGroup(site, "pgtest-reach", 2);
    const elsewhere = await createPhiTestUser(site);
    await grantCoreRole(site, elsewhere, PhiBaseRole.Staff);
    const customer = await createPhiTestUser(site);
    const admin = await createPhiTestUser(site);
    await grantCoreRole(site, admin, PhiBaseRole.Admin);

    const open = (createdByUserId: number, participantUserIds: number[]) => createThread({
      siteId: site.id,
      kind: PhisThreadKind.Direct,
      subject: "Reach",
      message: "Can you look at this?",
      participantUserIds,
      createdByUserId,
    });

    // A customer is not Staff and opens nothing; Staff reach Staff through a shared group only.
    await expect(open(customer, [opener])).rejects.toThrow(/Only Staff may open/u);
    await expect(open(opener, [customer])).rejects.toThrow(/Only Staff can be brought/u);
    await expect(open(opener, [elsewhere])).rejects.toThrow(/share no group/u);
    expect((await open(opener, [colleague])).participants).toHaveLength(2);

    // Admin's reach is every Staff member, and no group is needed for it.
    expect((await open(admin, [elsewhere])).participants).toHaveLength(2);

    // Bringing somebody in afterwards is held to the same answer.
    const between = await open(opener, [colleague]);
    await expect(addThreadParticipants({
      siteId: site.id,
      threadId: between.thread.id,
      reader: { kind: "user", userId: opener },
      participantUserIds: [elsewhere],
    })).rejects.toThrow(/share no group/u);
    await expect(addThreadParticipants({
      siteId: site.id,
      threadId: between.thread.id,
      reader: { kind: "user", userId: opener },
      participantGroupIds: [(await createStaffWhoShareAGroup(site, "pgtest-reach-other", 0)).group],
    })).rejects.toThrow(/between people/u);
  });

  it("opens a group's thread to its Author, where the group holds threads at all", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-group-authority");
    await offerAllThreadKinds(site);
    const group = await createPhiTestGroup(site, "pgtest-authority");
    const member = await createPhiTestUser(site);
    const author = await createPhiTestUser(site);
    const admin = await createPhiTestUser(site);
    await addPhiTestGroupMember({ site, groupId: group, userId: member, membershipFlags: 1 });
    await addPhiTestGroupMember({ site, groupId: group, userId: author, membershipFlags: 3 });
    await grantCoreRole(site, admin, PhiBaseRole.Admin);

    const open = (createdByUserId: number) => createThread({
      siteId: site.id,
      kind: PhisThreadKind.Group,
      subject: "Group business",
      message: "Anyone here?",
      participantGroupIds: [group],
      createdByUserId,
    });

    // The flag comes first: five thousand customers grouped for Page access are not a chat room.
    await expect(open(author)).rejects.toThrow(/does not hold threads/u);
    await setSiteGroupFlags(site.id, group, PhiSiteGroupFlags.Threads);
    await expect(open(member)).rejects.toThrow(/Author level/u);
    const opened = await open(author);
    expect(opened.thread.kind).toBe(PhisThreadKind.Group);
    // Admin needs no level in the group, but the group still has to hold threads.
    expect((await open(admin)).thread.kind).toBe(PhisThreadKind.Group);

    // A group's thread is the group's: nobody is added to it, and nobody but the group is named.
    await expect(addThreadParticipants({
      siteId: site.id,
      threadId: opened.thread.id,
      reader: { kind: "user", userId: author },
      participantUserIds: [admin],
    })).rejects.toThrow(/join the group/u);
    await expect(createThread({
      siteId: site.id,
      kind: PhisThreadKind.Group,
      subject: "Plus one",
      message: "And you.",
      participantGroupIds: [group],
      participantUserIds: [admin],
      createdByUserId: author,
    })).rejects.toThrow(/nobody else/u);
  });

  it("lets groups talk to each other only where every one of them may be addressed", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-cross");
    await offerAllThreadKinds(site);
    const ours = await createPhiTestGroup(site, "pgtest-ours");
    const theirs = await createPhiTestGroup(site, "pgtest-theirs");
    const author = await createPhiTestUser(site);
    await addPhiTestGroupMember({ site, groupId: ours, userId: author, membershipFlags: 3 });
    await setSiteGroupFlags(site.id, ours, PhiSiteGroupFlags.CrossGroupThreads | PhiSiteGroupFlags.Threads);

    const open = () => createThread({
      siteId: site.id,
      kind: PhisThreadKind.CrossGroup,
      subject: "Between us",
      message: "Shall we?",
      participantGroupIds: [ours, theirs],
      createdByUserId: author,
    });

    await expect(open()).rejects.toThrow(/may not address other groups/u);
    await setSiteGroupFlags(site.id, theirs, PhiSiteGroupFlags.CrossGroupThreads | PhiSiteGroupFlags.Threads);
    expect((await open()).thread.kind).toBe(PhisThreadKind.CrossGroup);
  });

  it("opens a Support thread only with its ticket", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-support-door");
    await offerAllThreadKinds(site);
    const customer = await createPhiTestUser(site);
    const queueGroup = await createPhiTestGroup(site, "pgtest-queue");

    // What any signed-in member could do before: name the queue's group and skip the ticket.
    await expect(createThread({
      siteId: site.id,
      kind: PhisThreadKind.Support,
      subject: "Help",
      message: "Straight to the queue.",
      participantGroupIds: [queueGroup],
      createdByUserId: customer,
    })).rejects.toThrow(/opens with its ticket/u);
  });

  it("withholds an internal note from everyone but Staff", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-internal");
    await offerAllThreadKinds(site);
    const supporter = await createPhiTestUser(site);
    const customer = await createPhiTestUser(site);
    await grantCoreRole(site, supporter, PhiBaseRole.Supporter);

    const threadId = await openSupportThread(site, { requester: customer, supporter });

    await addThreadMessage({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId: supporter },
      message: "Looks like the payment provider again.",
      messageFlags: PhisThreadMessageFlag.Internal,
    });

    const asStaff = await getThreadDetail(site.id, { kind: "user", userId: supporter }, threadId);
    const asCustomer = await getThreadDetail(site.id, { kind: "user", userId: customer }, threadId);
    expect(asStaff?.messages).toHaveLength(2);
    expect(asCustomer?.messages).toHaveLength(1);

    // A customer may not write one either, whatever they ask for.
    await addThreadMessage({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId: customer },
      message: "Any news?",
      messageFlags: PhisThreadMessageFlag.Internal,
    });
    const afterCustomer = await getThreadDetail(
      site.id,
      { kind: "user", userId: customer },
      threadId,
    );
    expect(afterCustomer?.messages).toHaveLength(2);
  });

  it("does not show a customer their thread as changed by a note they cannot read", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-internal-unread");
    await offerAllThreadKinds(site);
    const supporter = await createPhiTestUser(site);
    const customer = await createPhiTestUser(site);
    await grantCoreRole(site, supporter, PhiBaseRole.Supporter);
    const threadId = await openSupportThread(site, { requester: customer, supporter });
    expect(await markThreadRead(site.id, customer, threadId)).toBe(true);
    const before = (await listThreadsForUser(site.id, customer)).rows.find((row) => row.id === threadId);

    await addThreadMessage({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId: supporter },
      message: "Internal only.",
      messageFlags: PhisThreadMessageFlag.Internal,
    });

    const customerUnread = await listThreadsForUser(site.id, customer, { unreadOnly: true });
    expect(customerUnread.rows.map((row) => row.id)).not.toContain(threadId);
    const after = (await listThreadsForUser(site.id, customer)).rows.find((row) => row.id === threadId);
    expect(after?.latestMessageAt).toEqual(before?.latestMessageAt);
    const staffUnread = await listThreadsForUser(site.id, supporter, { unreadOnly: true });
    expect(staffUnread.rows.map((row) => row.id)).not.toContain(threadId);
  });

  it("tracks unread against the newest message", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-unread");
    await offerAllThreadKinds(site);
    const { users: [author, reader] } = await createStaffWhoShareAGroup(site, "pgtest-unread", 2);

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

    // A read mark is a message of this thread: one of another thread's would move it by its id.
    const elsewhere = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Direct,
      message: "Elsewhere.",
      participantUserIds: [reader],
      createdByUserId: author,
    });
    const foreignMessageId = elsewhere.messages.at(-1)?.id ?? 0;
    await expect(markThreadRead(site.id, reader, opened.thread.id, foreignMessageId))
      .rejects.toThrow(/not part of this thread/u);
  });

  it("leaves a Support thread's status to the queue, not to its requester", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-support-status");
    await offerAllThreadKinds(site);
    const requester = await createPhiTestUser(site);
    const supporter = await createPhiTestUser(site);
    await grantCoreRole(site, supporter, PhiBaseRole.Staff);
    const threadId = await openSupportThread(site, { requester, supporter });

    await expect(setThreadStatus({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId: requester },
      status: PhisThreadStatus.Archived,
    })).rejects.toThrow(/requester of a Support thread/u);
    expect(await setThreadStatus({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId: supporter },
      status: PhisThreadStatus.Archived,
    })).toBe(true);
  });

  it("archives for everyone and refuses new messages", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-archive");
    await offerAllThreadKinds(site);
    const { users: [author, other] } = await createStaffWhoShareAGroup(site, "pgtest-archive", 2);

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

  it("leaves closing a group's thread to its opener, Staff and the group's Managers", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-archive-authority");
    await offerAllThreadKinds(site);
    const group = await createPhiTestGroup(site, "pgtest-archive-authority");
    await setSiteGroupFlags(site.id, group, PhiSiteGroupFlags.Threads);
    const author = await createPhiTestUser(site);
    const member = await createPhiTestUser(site);
    const manager = await createPhiTestUser(site);
    const staff = await createPhiTestUser(site);
    await addPhiTestGroupMember({ site, groupId: group, userId: author, membershipFlags: 3 });
    await addPhiTestGroupMember({ site, groupId: group, userId: member, membershipFlags: 1 });
    await addPhiTestGroupMember({ site, groupId: group, userId: manager, membershipFlags: 15 });
    // Staff in the group at the lowest level, so that only the Core role can be what admits them.
    await addPhiTestGroupMember({ site, groupId: group, userId: staff, membershipFlags: 1 });
    await grantCoreRole(site, staff, PhiBaseRole.Staff);

    const opened = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Group,
      subject: "Group business",
      message: "Anyone here?",
      participantGroupIds: [group],
      createdByUserId: author,
    });
    const set = (userId: number, status: Parameters<typeof setThreadStatus>[0]["status"]) => setThreadStatus({
      siteId: site.id,
      threadId: opened.thread.id,
      reader: { kind: "user", userId },
      status,
    });

    // A member reads and writes like everybody else, and still may not end it for all of them.
    await expect(set(member, PhisThreadStatus.Archived)).rejects.toThrow(/Only whoever opened this thread/u);
    expect(await set(manager, PhisThreadStatus.Archived)).toBe(true);
    await expect(set(member, PhisThreadStatus.Open)).rejects.toThrow(/Only whoever opened this thread/u);
    expect(await set(author, PhisThreadStatus.Open)).toBe(true);
    expect(await set(staff, PhisThreadStatus.Archived)).toBe(true);
  });

  it("brings people in without letting them read what came before they could be seen", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-participants");
    await offerAllThreadKinds(site);
    const { users: [author, first, second] } = await createStaffWhoShareAGroup(site, "pgtest-widen", 3);

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
    // An Add-on acting for a person is that person: the two ends of its Direct thread are Staff who
    // share a group, exactly as if the person had opened it.
    const { users: [actor, recipient] } = await createStaffWhoShareAGroup(site, "pgtest-capability", 2);
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
    const { users: [person, recipient] } = await createStaffWhoShareAGroup(site, "pgtest-actorless", 2);

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
    const { users: [person, recipient] } = await createStaffWhoShareAGroup(site, "pgtest-confidential", 2);

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
