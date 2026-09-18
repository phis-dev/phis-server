import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PhisSupportQueueFlag, PhisSupportTicketTypeFlag } from "@phis/contracts/support";
import { PhisSiteThreadKindFlag, PhisThreadParticipantFlag } from "@phis/contracts/threads";

import {
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  SUPPORT_TICKET_CHANNEL_PORTAL,
  createSupportQueue,
  createSupportTicket,
  createSupportTicketType,
  getRequestableSupportTicketType,
  hasSupportEntryQueue,
  listRequestableSupportTicketTypes,
  updateSupportQueue,
  updateSupportTicketType,
} from "./support";

const configured = process.env.PHIS_PG_TEST === "1";

/**
 * What a requester may choose, and what opening a request records.
 *
 * The listing is a narrower answer than the Staff catalogue rather than a filter over it, and the
 * difference is what keeps a Site-only type from being offered to the public. The consent is the other
 * half: a ticket whose conversation leaves the Site carries the requester's acknowledgement from the
 * moment they wrote, because asking afterwards is asking too late.
 */
describe.skipIf(!configured)("support requests", () => {
  let site: PhiTestSite;
  let groupId: number;
  let requester: number;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("support-request");
    await pool.query(
      `INSERT INTO phis.site_thread_config (site_id, flags) VALUES ($1, $2)
       ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags`,
      [site.id, PhisSiteThreadKindFlag.Support],
    );
    groupId = await createPhiTestGroup(site, "pgtest-support-request");
    requester = await createPhiTestUser(site);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("offers nothing before the Site has looked at its catalogue", async () => {
    await createSupportTicketType({ siteId: site.id, key: "seeded", name: "Seeded" });
    // A type a Module's seed brought with it is Staff-only until the Site says otherwise.
    expect(await listRequestableSupportTicketTypes(site.id, requester)).toEqual([]);
    expect(await getRequestableSupportTicketType(site.id, "seeded")).toBeNull();
  });

  it("says which types leave the Site, so a person is told before they write", async () => {
    const outward = await createSupportTicketType({
      siteId: site.id,
      key: "bug",
      name: "Bug",
      flags: PhisSupportTicketTypeFlag.Requestable | PhisSupportTicketTypeFlag.External,
    });
    await createSupportTicketType({
      siteId: site.id,
      key: "question",
      name: "Question",
      flags: PhisSupportTicketTypeFlag.Requestable,
    });

    const offered = await listRequestableSupportTicketTypes(site.id, requester);
    expect(offered).toEqual([
      { key: "bug", name: "Bug", external: true, allowance: null },
      { key: "question", name: "Question", external: false, allowance: null },
    ]);
    // The Staff-only type is absent rather than listed as forbidden: naming it would say it exists.
    expect(offered.some((type) => type.key === "seeded")).toBe(false);

    await updateSupportTicketType({ siteId: site.id, typeId: outward, retired: true });
    expect((await listRequestableSupportTicketTypes(site.id, requester)).map((type) => type.key))
      .toEqual(["question"]);
    await updateSupportTicketType({ siteId: site.id, typeId: outward, retired: false });
  });

  it("has nowhere for a request to land until a queue is marked as the way in", async () => {
    expect(await hasSupportEntryQueue(site.id)).toBe(false);
    const queueId = await createSupportQueue({
      siteId: site.id, groupId, key: "entry", name: "Support",
      flags: PhisSupportQueueFlag.Entry,
    });
    expect(await hasSupportEntryQueue(site.id)).toBe(true);
    expect(queueId).toBeGreaterThan(0);
  });

  it("records the requester's consent on the thread when the conversation leaves the Site", async () => {
    const type = await getRequestableSupportTicketType(site.id, "bug");
    const created = await createSupportTicket({
      siteId: site.id,
      typeId: type!.id,
      subject: "The export fails",
      message: "It stops at 40%.",
      channel: SUPPORT_TICKET_CHANNEL_PORTAL,
      requesterUserId: requester,
      createdByUserId: requester,
      requesterExternalConsent: true,
    });

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ flags: number }>(
      `SELECT flags FROM phis.thread_participants
       WHERE thread_id = $1 AND user_id = $2`,
      [created!.ticket.threadId, requester],
    );
    // Both: the person the thread is about, and their acknowledgement that it is mirrored outward.
    expect(rows[0]!.flags & PhisThreadParticipantFlag.Requester).not.toBe(0);
    expect(rows[0]!.flags & PhisThreadParticipantFlag.ExternalConsent).not.toBe(0);
    // No queue was named, so the entry queue decided.
    expect(created!.ticket.queueId).not.toBeNull();
  });

  it("leaves consent unset where nothing leaves the Site", async () => {
    const type = await getRequestableSupportTicketType(site.id, "question");
    const created = await createSupportTicket({
      siteId: site.id,
      typeId: type!.id,
      subject: "How do I export?",
      message: "I cannot find it.",
      channel: SUPPORT_TICKET_CHANNEL_PORTAL,
      requesterUserId: requester,
      createdByUserId: requester,
      requesterExternalConsent: false,
    });

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ flags: number }>(
      `SELECT flags FROM phis.thread_participants
       WHERE thread_id = $1 AND user_id = $2`,
      [created!.ticket.threadId, requester],
    );
    expect(rows[0]!.flags & PhisThreadParticipantFlag.ExternalConsent).toBe(0);
  });

  it("stops offering a type once the Site takes the mark off it", async () => {
    const type = await getRequestableSupportTicketType(site.id, "question");
    await updateSupportTicketType({ siteId: site.id, typeId: type!.id, flags: 0 });
    expect(await getRequestableSupportTicketType(site.id, "question")).toBeNull();
  });

  it("keeps the Site's way in once a request has used it", async () => {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM phis.support_queues WHERE site_id = $1 AND key = 'entry'`,
      [site.id],
    );
    await expect(updateSupportQueue({
      siteId: site.id, queueId: rows[0]!.id, retired: true,
    })).rejects.toThrow(/entry queue cannot be retired/);
  });
});
