import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
} from "../../test/pg/harness";
import {
  SUPPORT_THREAD_STATUS_ARCHIVED,
  SUPPORT_THREAD_STATUS_OPEN,
  SUPPORT_THREAD_TYPE_DIRECT,
  SUPPORT_THREAD_TYPE_MIXED,
  addSupportThreadRecipients,
  createSupportTeam,
  createSupportThread,
  getSupportThreadDetail,
  updateSupportThread,
} from "./support";
import {
  PhisAddonThreadsError,
  buildPhisAddonThreadsCapability,
} from "@/lib/addons/threads-capability";

/**
 * Threads as an Add-on and as a person reach them.
 *
 * Three things here were broken or missing until the capability needed them, and each is silent in a
 * way a unit test cannot catch: a thread opened with no author read itself back through a visibility
 * predicate and came back null; a thread's status had no writer at all, so archiving was a word;
 * and adding a recipient to a direct thread left it typed as the thread it used to be.
 */
describe("support threads", () => {
  beforeAll(async () => {
    await dropPhiTestSites();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("returns a thread opened with no author", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-system");
    const recipient = await createPhiTestUser(site);

    const detail = await createSupportThread({
      siteId: site.id,
      subject: "Opened by nobody",
      message: "An outside event reported itself.",
      recipientUserIds: [recipient],
      createdByUserId: null,
    });

    expect(detail).not.toBeNull();
    expect(detail?.thread.createdByUserId).toBeNull();
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.hasMoreMessages).toBe(false);
  });

  it("archives a thread and types it again when a team joins", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-life");
    const author = await createPhiTestUser(site);
    const recipient = await createPhiTestUser(site);
    const team = await createSupportTeam({
      siteId: site.id,
      key: "pgtest-team",
      name: "Pgtest Team",
    });

    const created = await createSupportThread({
      siteId: site.id,
      message: "One person to one person.",
      recipientUserIds: [recipient],
      createdByUserId: author,
    });
    expect(created?.thread.type).toBe(SUPPORT_THREAD_TYPE_DIRECT);
    expect(created?.thread.status).toBe(SUPPORT_THREAD_STATUS_OPEN);
    const threadId = created!.thread.id;

    const widened = await addSupportThreadRecipients({
      siteId: site.id,
      threadId,
      actingUserId: author,
      recipientTeamIds: [team!.id],
    });
    expect(widened?.thread.type).toBe(SUPPORT_THREAD_TYPE_MIXED);

    const archived = await updateSupportThread({
      siteId: site.id,
      threadId,
      actingUserId: author,
      status: SUPPORT_THREAD_STATUS_ARCHIVED,
    });
    expect(archived?.thread.status).toBe(SUPPORT_THREAD_STATUS_ARCHIVED);

    await expect(
      updateSupportThread({ siteId: site.id, threadId, actingUserId: author, status: 99 }),
    ).rejects.toThrow(/Unknown support thread status/u);
  });

  it("refuses to answer a stranger", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-visibility");
    const author = await createPhiTestUser(site);
    const recipient = await createPhiTestUser(site);
    const stranger = await createPhiTestUser(site);

    const created = await createSupportThread({
      siteId: site.id,
      message: "Not for everybody.",
      recipientUserIds: [recipient],
      createdByUserId: author,
    });

    expect(await getSupportThreadDetail(site.id, recipient, created!.thread.id)).not.toBeNull();
    expect(await getSupportThreadDetail(site.id, stranger, created!.thread.id)).toBeNull();
  });

  it("offers an Add-on only what its actor may reach", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-capability");
    const actor = await createPhiTestUser(site);
    const recipient = await createPhiTestUser(site);

    const asActor = buildPhisAddonThreadsCapability({
      addonId: "@probe/threads",
      siteId: site.id,
      actorUserId: actor,
    });
    const opened = await asActor.create({
      subject: "From an Add-on",
      message: "Hello from a handler.",
      recipientUserIds: [recipient],
    });
    expect(opened.thread.subject).toBe("From an Add-on");

    const listed = await asActor.list();
    expect(listed.map((thread) => thread.id)).toContain(opened.thread.id);

    const replied = await asActor.reply({ threadId: opened.thread.id, message: "And again." });
    expect(replied?.messages).toHaveLength(2);
    expect(await asActor.archive(opened.thread.id)).toBe(true);

    // A stranger's capability is bounded by the stranger, not by the Add-on.
    const outsider = await createPhiTestUser(site);
    const asOutsider = buildPhisAddonThreadsCapability({
      addonId: "@probe/threads",
      siteId: site.id,
      actorUserId: outsider,
    });
    expect(await asOutsider.get(opened.thread.id)).toBeNull();
    expect(await asOutsider.archive(opened.thread.id)).toBe(false);
  });

  it("lets an actorless Add-on open a thread and nothing else", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("threads-actorless");
    const recipient = await createPhiTestUser(site);

    const asJob = buildPhisAddonThreadsCapability({
      addonId: "@probe/threads",
      siteId: site.id,
      actorUserId: null,
    });

    const opened = await asJob.create({
      message: "A job reporting an outside event.",
      recipientUserIds: [recipient],
    });
    expect(opened.thread.id).toBeGreaterThan(0);

    await expect(asJob.list()).rejects.toThrow(PhisAddonThreadsError);
    await expect(asJob.get(opened.thread.id)).rejects.toThrow(/no acting user/u);
    await expect(
      asJob.reply({ threadId: opened.thread.id, message: "nope" }),
    ).rejects.toThrow(/only threads.create is available/u);
  });
});
