import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { PHIS_ADDON_EVENTS, PhisSiteThreadKindFlag, PhisThreadKind } from "@phis/contracts/addon";

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
});
