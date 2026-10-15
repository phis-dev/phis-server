import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { PhisSupportQueueFlag, PhisSupportTicketStatus } from "@phis/contracts/support";
import { PhisSiteThreadKindFlag } from "@phis/contracts/threads";

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
import { applySupportTicketAssignmentAction, createSupportTicket } from "./support";
import { listSupportTicketEvents } from "./support-ticket-events";

/**
 * A ticket's history reads back what was written, in what a person recognises: kinds as words, queues
 * by name, people by id -- oldest first, and only within the Site the ticket belongs to.
 */

async function seedSupport(site: PhiTestSite) {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.site_thread_config (site_id, flags, requester_window_days)
     VALUES ($1, $2, 14)
     ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags`,
    [site.id, PhisSiteThreadKindFlag.Support],
  );
  const groupId = await createPhiTestGroup(site, "pgtest-events-queue");
  const entry = await pool.query<{ id: number }>(
    `INSERT INTO phis.support_queues (site_id, group_id, key, name, flags)
     VALUES ($1, $2, 'entry', 'Entry', $3) RETURNING id`,
    [site.id, groupId, PhisSupportQueueFlag.Entry],
  );
  const second = await pool.query<{ id: number }>(
    `INSERT INTO phis.support_queues (site_id, group_id, key, name, flags)
     VALUES ($1, $2, 'billing', 'Billing', 0) RETURNING id`,
    [site.id, groupId],
  );
  const type = await pool.query<{ id: number }>(
    `INSERT INTO phis.support_ticket_types (site_id, key, name, flags, close_policy)
     VALUES ($1, 'request', 'Request', 0, 0) RETURNING id`,
    [site.id],
  );
  return { groupId, entryQueueId: entry.rows[0]!.id, billingQueueId: second.rows[0]!.id, typeId: type.rows[0]!.id };
}

describe("support ticket events", () => {
  beforeAll(async () => {
    await dropPhiTestSites();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("reads opening, taking and a queue move back in order, with the queues by name", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("events-history");
    const { groupId, billingQueueId, typeId } = await seedSupport(site);
    const requester = await createPhiTestUser(site);
    const supporter = await createPhiTestUser(site);
    await addPhiTestGroupMember({ site, groupId, userId: supporter });
    const created = await createSupportTicket({
      siteId: site.id,
      typeId,
      channel: 0,
      subject: "The export fails",
      message: "It fails every time.",
      requesterUserId: requester,
      createdByUserId: requester,
    });
    const ticketId = created!.ticket.id;
    await applySupportTicketAssignmentAction({ siteId: site.id, ticketId, action: "assign_to_me", userId: supporter });
    await applySupportTicketAssignmentAction({
      siteId: site.id, ticketId, action: "move_to_queue", userId: supporter, queueId: billingQueueId,
    });

    const events = (await listSupportTicketEvents(site.id, ticketId))!;
    expect(events[0]).toMatchObject({
      kind: "created",
      toStatus: PhisSupportTicketStatus.New,
      toQueue: "Entry",
      actor: { userId: requester },
    });
    const assigned = events.find((event) => event.kind === "assigned" && event.toAssignee?.userId === supporter);
    expect(assigned).toMatchObject({ actor: { userId: supporter } });
    expect(assigned).not.toHaveProperty("toQueue");
    expect(events.find((event) => event.fromQueue === "Entry")).toMatchObject({ kind: "assigned", toQueue: "Billing" });
    const times = events.map((event) => Date.parse(event.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("answers no history for a ticket of another Site", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("events-own");
    const other = await createPhiTestSite("events-other");
    const { typeId } = await seedSupport(site);
    const requester = await createPhiTestUser(site);
    const created = await createSupportTicket({
      siteId: site.id, typeId, channel: 0, subject: "Mine", message: "Mine.",
      requesterUserId: requester, createdByUserId: requester,
    });
    expect(await listSupportTicketEvents(other.id, created!.ticket.id)).toBeNull();
  });
});
