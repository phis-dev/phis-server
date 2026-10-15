import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { PHIS_ADDON_EVENTS, PhisSiteThreadKindFlag, PhisThreadKind } from "@phis/contracts/addon";
import { PhiBaseRole } from "@phis/contracts/access";

import {
  enablePhiTestAddonForSite,
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { createThread, addThreadMessage, setThreadStatus } from "./threads";
import { deleteResourceLink, upsertResourceLink } from "./resource-links";
import { buildPhisAddonThreadsCapability } from "@/lib/addons/threads-capability";
import { PhisThreadMessageFlag } from "@phis/contracts/threads";

/**
 * The outbox, and the one thing it must never become: a feed of a Site's conversations.
 *
 * Every rule here is written as a join and is therefore PostgreSQL's answer rather than a function's --
 * who is owed an event, which Add-on is enabled enough to be owed one, and what the link going away
 * takes with it. A unit test would have to reimplement each of them to assert on them.
 */

const ADDON_ID = "@probe/events";
const OTHER_ADDON_ID = "@probe/bystander";
const LINK_TYPE = 20;
const SYNCED = 1;

async function offerThreadKinds(site: PhiTestSite) {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.site_thread_config (site_id, flags)
     VALUES ($1, $2)
     ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags`,
    [site.id, PhisSiteThreadKindFlag.Direct],
  );
}

async function readOutbox(site: PhiTestSite) {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ addon_id: string; event: string; payload: unknown }>(
    `SELECT addon_id, event, payload
     FROM phis.addon_event_outbox
     WHERE site_id = $1
     ORDER BY id ASC`,
    [site.id],
  );
  return rows;
}

async function openThread(site: PhiTestSite, userId: number) {
  // Only Staff open a Direct thread, and any Core role is what makes somebody Staff.
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.user_site_role_claims (site_id, user_id, provider_id, role_flags)
     VALUES ($1, $2, '@phis/server/core', $3)
     ON CONFLICT (site_id, user_id, provider_id) DO UPDATE SET role_flags = EXCLUDED.role_flags`,
    [site.id, userId, PhiBaseRole.Staff],
  );
  const detail = await createThread({
    siteId: site.id,
    kind: PhisThreadKind.Direct,
    subject: "Outbox",
    message: "First.",
    participantUserIds: [userId],
    createdByUserId: userId,
  });
  return detail.thread.id;
}

describe("the Add-on event outbox", () => {
  beforeAll(async () => {
    await dropPhiTestSites();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = ANY($1::varchar[])`, [
      [ADDON_ID, OTHER_ADDON_ID],
    ]);
    await closePhiTestPool();
  });

  it("owes nobody anything for a thread nothing is linked to", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("events-unlinked");
    await offerThreadKinds(site);
    await enablePhiTestAddonForSite(site, ADDON_ID);
    const author = await createPhiTestUser(site);

    const threadId = await openThread(site, author);
    await addThreadMessage({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId: author },
      message: "Second.",
    });

    // The Add-on is installed, enabled and declares nothing to the contrary. What it lacks is the one
    // thing that grants reach: somebody's link.
    expect(await readOutbox(site)).toEqual([]);
  });

  it("owes the Add-on a person linked, and only that one", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("events-linked");
    await offerThreadKinds(site);
    await enablePhiTestAddonForSite(site, ADDON_ID);
    await enablePhiTestAddonForSite(site, OTHER_ADDON_ID);
    const author = await createPhiTestUser(site);

    const threadId = await openThread(site, author);
    await upsertResourceLink({
      siteId: site.id,
      providerId: ADDON_ID,
      subject: { kind: "thread", id: threadId },
      type: LINK_TYPE,
      externalId: "issue-1",
      flags: SYNCED,
      createdByUserId: author,
    });

    await addThreadMessage({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId: author },
      message: "Second.",
    });

    const owed = await readOutbox(site);
    expect(owed).toHaveLength(1);
    expect(owed[0]?.addon_id).toBe(ADDON_ID);
    expect(owed[0]?.event).toBe(PHIS_ADDON_EVENTS.threadMessageCreated);
  });

  it("does not hand an Add-on back the message it just imported", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("events-echo");
    await offerThreadKinds(site);
    await enablePhiTestAddonForSite(site, ADDON_ID);
    const author = await createPhiTestUser(site);

    const threadId = await openThread(site, author);
    await upsertResourceLink({
      siteId: site.id,
      providerId: ADDON_ID,
      subject: { kind: "thread", id: threadId },
      type: LINK_TYPE,
      externalId: "issue-2",
      flags: SYNCED,
      createdByUserId: author,
    });

    await addThreadMessage({
      siteId: site.id,
      threadId,
      reader: { kind: "provider", providerId: ADDON_ID },
      message: "Said outside, brought in.",
      externalRef: "comment-1",
    });

    // Two systems telling each other what the other just said is a loop that ends when somebody runs
    // out of quota. The author is the one recipient the enqueue leaves out.
    expect(await readOutbox(site)).toEqual([]);
  });

  it("announces a status change once, and not the one that changed nothing", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("events-status");
    await offerThreadKinds(site);
    await enablePhiTestAddonForSite(site, ADDON_ID);
    const author = await createPhiTestUser(site);

    const threadId = await openThread(site, author);
    await upsertResourceLink({
      siteId: site.id,
      providerId: ADDON_ID,
      subject: { kind: "thread", id: threadId },
      type: LINK_TYPE,
      externalId: "issue-3",
      flags: SYNCED,
      createdByUserId: author,
    });

    await setThreadStatus({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId: author },
      status: 1,
    });
    await setThreadStatus({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId: author },
      status: 1,
    });

    const owed = (await readOutbox(site)).filter(
      (row) => row.event === PHIS_ADDON_EVENTS.threadStatusChanged,
    );
    expect(owed).toHaveLength(1);
  });

  it("tells the Add-on the link is gone, which is the last thing the link can do", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("events-unlink");
    await offerThreadKinds(site);
    await enablePhiTestAddonForSite(site, ADDON_ID);
    const author = await createPhiTestUser(site);

    const threadId = await openThread(site, author);
    const link = await upsertResourceLink({
      siteId: site.id,
      providerId: ADDON_ID,
      subject: { kind: "thread", id: threadId },
      type: LINK_TYPE,
      externalId: "issue-4",
      flags: SYNCED,
      createdByUserId: author,
    });

    expect(await deleteResourceLink({
      siteId: site.id,
      providerId: ADDON_ID,
      linkId: link.id,
    })).toBe(true);

    const owed = await readOutbox(site);
    expect(owed.map((row) => row.event)).toContain(PHIS_ADDON_EVENTS.threadLinkRemoved);

    // And the reach ends with it: a message written afterwards owes this Add-on nothing, because the
    // row that would have found it is gone.
    const before = owed.length;
    await addThreadMessage({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId: author },
      message: "After the unlink.",
    });
    expect(await readOutbox(site)).toHaveLength(before);
  });

  it("tells the Add-on that owns a thread, which nobody could have linked", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("events-owned");
    await offerThreadKinds(site);
    await enablePhiTestAddonForSite(site, ADDON_ID);
    const author = await createPhiTestUser(site);
    await openThread(site, author);
    const owned = await createThread({
      siteId: site.id,
      kind: PhisThreadKind.Direct,
      subject: "Arrived from outside",
      message: "Opened by the integration.",
      participantUserIds: [author],
      createdByUserId: null,
      ownerProviderId: ADDON_ID,
    });
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.addon_event_outbox WHERE site_id = $1`, [site.id]);

    await addThreadMessage({
      siteId: site.id,
      threadId: owned.thread.id,
      reader: { kind: "user", userId: author },
      message: "Answered by a person.",
    });
    expect((await readOutbox(site)).map((row) => row.addon_id)).toEqual([ADDON_ID]);
  });

  it("keeps an integration's record of what it wrote out and changes only what it brought in", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("events-export");
    await offerThreadKinds(site);
    await enablePhiTestAddonForSite(site, ADDON_ID);
    await enablePhiTestAddonForSite(site, OTHER_ADDON_ID);
    const author = await createPhiTestUser(site);
    const threadId = await openThread(site, author);
    for (const providerId of [ADDON_ID, OTHER_ADDON_ID]) {
      await upsertResourceLink({
        siteId: site.id,
        providerId,
        subject: { kind: "thread", id: threadId },
        type: LINK_TYPE,
        externalId: `issue-export-${providerId}`,
        flags: SYNCED,
        createdByUserId: author,
      });
    }
    const threads = buildPhisAddonThreadsCapability({ addonId: ADDON_ID, siteId: site.id, actorUserId: null });

    const written = await addThreadMessage({
      siteId: site.id, threadId, reader: { kind: "user", userId: author }, message: "Written here.",
    });
    const writtenId = written!.messages.at(-1)!.id;
    expect(await threads.recordExport({ messageId: writtenId, externalRef: "gh-comment-1" })).toBe(true);
    // A redelivered event finds the first export and posts nothing.
    expect(await threads.recordExport({ messageId: writtenId, externalRef: "gh-comment-1" })).toBe(false);
    expect(await threads.findExport(writtenId)).toBe("gh-comment-1");

    await threads.reply({ threadId, message: "Said there.", externalRef: "gh-comment-2" });
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.addon_event_outbox WHERE site_id = $1`, [site.id]);

    expect(await threads.amendImported({ externalRef: "gh-comment-2", message: "Said there, corrected." })).toBe(true);
    const edited = await pool.query<{ body_text: string; flags: number }>(
      `SELECT message.body_text, message.flags FROM phis.thread_messages message
       JOIN phis.thread_message_refs ref ON ref.message_id = message.id
       WHERE ref.site_id = $1 AND ref.external_id = 'gh-comment-2'`,
      [site.id],
    );
    expect(edited.rows[0]?.body_text).toBe("Said there, corrected.");
    expect((edited.rows[0]!.flags & PhisThreadMessageFlag.Edited) !== 0).toBe(true);
    // The other integration in the conversation hears about it; the one that changed it does not.
    expect((await readOutbox(site)).map((row) => [row.addon_id, row.event]))
      .toEqual([[OTHER_ADDON_ID, PHIS_ADDON_EVENTS.threadMessageUpdated]]);

    expect(await threads.amendImported({ externalRef: "gh-comment-2", message: null })).toBe(true);
    const withdrawn = await pool.query<{ body_text: string; flags: number }>(
      `SELECT message.body_text, message.flags FROM phis.thread_messages message
       JOIN phis.thread_message_refs ref ON ref.message_id = message.id
       WHERE ref.site_id = $1 AND ref.external_id = 'gh-comment-2'`,
      [site.id],
    );
    expect(withdrawn.rows[0]?.body_text).toBe("");
    expect((withdrawn.rows[0]!.flags & PhisThreadMessageFlag.Redacted) !== 0).toBe(true);

    // What it wrote out, or what a person wrote, is not its to change.
    expect(await threads.amendImported({ externalRef: "gh-comment-1", message: "No." })).toBe(false);
  });
});
