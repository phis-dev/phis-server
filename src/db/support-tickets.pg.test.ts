import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
  PhisSupportQueueFlag,
  PhisSupportTicketTypeFlag,
} from "@phis/contracts/support";
import { PhisSiteThreadKindFlag, PhisThreadKind } from "@phis/contracts/threads";

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
  addSupportTicketTask,
  createSupportTicket,
  getSupportTicketDetail,
  SupportAdministrationError,
  updateSupportTicket,
  type UpdateSupportTicketInput,
} from "./support";
import { getThreadDetail } from "./threads";

/**
 * A ticket and its conversation are one write.
 *
 * The ticket is the workflow record and the thread is what anybody said about it, so a ticket whose
 * thread failed to open is a record nobody can answer. What is asserted here is that the two land
 * together, that the queue's group is what makes the thread visible to Support, and that routing is
 * required rather than guessed at.
 */

async function seedSupport(site: PhiTestSite) {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.site_thread_config (site_id, flags)
     VALUES ($1, $2)
     ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags`,
    [site.id, PhisSiteThreadKindFlag.Support],
  );

  const groupId = await createPhiTestGroup(site, "pgtest-support-queue");
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.support_queues (site_id, group_id, key, name, flags)
     VALUES ($1, $2, 'support_l1', 'Support L1', $3)
     RETURNING id`,
    [site.id, groupId, PhisSupportQueueFlag.Entry],
  );

  const typeRows = await pool.query<{ id: number }>(
    `INSERT INTO phis.support_ticket_types (site_id, key, name, flags, close_policy)
     VALUES ($1, 'question', 'Question', $2, 0)
     RETURNING id`,
    [site.id, PhisSupportTicketTypeFlag.External],
  );

  return { groupId, queueId: rows[0]!.id, typeId: typeRows.rows[0]!.id };
}

describe("support tickets", () => {
  beforeAll(async () => {
    await dropPhiTestSites();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("opens the ticket's thread and routes it to the entry queue", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("tickets-create");
    const { groupId, queueId, typeId } = await seedSupport(site);
    const requester = await createPhiTestUser(site);
    const supporter = await createPhiTestUser(site);
    await addPhiTestGroupMember({ site, groupId, userId: supporter });

    const created = await createSupportTicket({
      siteId: site.id,
      typeId,
      channel: 0,
      subject: "The export fails",
      message: "It fails with a 500 every time.",
      requesterUserId: requester,
      createdByUserId: requester,
    });

    expect(created?.ticket.typeId).toBe(typeId);
    // No queue was named, so the one marked as the entry is where it lands.
    expect(created?.ticket.queueId).toBe(queueId);
    expect(created?.ticket.threadId).toBeGreaterThan(0);

    const threadId = created!.ticket.threadId;
    const asRequester = await getThreadDetail(site.id, { kind: "user", userId: requester }, threadId);
    expect(asRequester?.thread.kind).toBe(PhisThreadKind.Support);
    expect(asRequester?.messages[0]?.bodyText).toBe("It fails with a 500 every time.");

    // The queue's group is what puts Support in the conversation; nobody was named individually.
    const asSupporter = await getThreadDetail(site.id, { kind: "user", userId: supporter }, threadId);
    expect(asSupporter).not.toBeNull();

    const stranger = await createPhiTestUser(site);
    expect(await getThreadDetail(site.id, { kind: "user", userId: stranger }, threadId)).toBeNull();

    const detail = await getSupportTicketDetail(site.id, created!.ticket.id);
    expect(detail?.ticket.threadId).toBe(threadId);
    expect(detail?.tasks).toEqual([]);
  });

  it("keeps a ticket's queue, type and people within its own Site", async () => {
    const pool = await requirePhiTestDatabase();
    const site = await createPhiTestSite("tickets-references");
    const { queueId, typeId } = await seedSupport(site);
    const elsewhere = await createPhiTestSite("tickets-elsewhere");
    const foreign = await seedSupport(elsewhere);
    const requester = await createPhiTestUser(site);
    const outsider = await createPhiTestUser(elsewhere);

    const created = await createSupportTicket({
      siteId: site.id,
      typeId,
      channel: 0,
      subject: "Where does this go?",
      message: "Nowhere else, please.",
      requesterUserId: requester,
      createdByUserId: requester,
    });
    const ticketId = created!.ticket.id;
    const patch = (fields: Omit<UpdateSupportTicketInput, "siteId" | "ticketId">) =>
      updateSupportTicket({ siteId: site.id, ticketId, ...fields });

    // Queue and type ids carry no Site of their own; the write has to ask for it.
    await expect(patch({ queueId: foreign.queueId })).rejects.toThrow(SupportAdministrationError);
    await expect(patch({ typeId: foreign.typeId })).rejects.toThrow(SupportAdministrationError);
    // A person is global; assigning or naming one who is not a member here is refused.
    await expect(patch({ assigneeUserId: outsider })).rejects.toThrow(SupportAdministrationError);
    await expect(addSupportTicketTask({
      siteId: site.id, ticketId, type: 0, status: 0, flags: 0, title: "Look", assigneeUserId: outsider,
    })).rejects.toThrow(SupportAdministrationError);
    // Nothing above changed the row.
    expect((await getSupportTicketDetail(site.id, ticketId))?.ticket).toMatchObject({
      queueId, typeId, assigneeUserId: null,
    });

    // A retired queue takes nothing new, however it is named.
    await pool.query(`UPDATE phis.support_queues SET retired_at = NOW() WHERE id = $1`, [queueId]);
    await expect(patch({ queueId })).rejects.toThrow(/no such queue/u);
    await pool.query(`UPDATE phis.support_queues SET retired_at = NULL WHERE id = $1`, [queueId]);
    expect((await patch({ queueId, assigneeUserId: requester }))?.ticket.assigneeUserId).toBe(requester);
  });

  it("refuses a ticket when nothing would route it", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("tickets-unrouted");
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.site_thread_config (site_id, flags)
       VALUES ($1, $2)
       ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags`,
      [site.id, PhisSiteThreadKindFlag.Support],
    );
    const groupId = await createPhiTestGroup(site, "pgtest-queue-not-entry");
    await pool.query(
      `INSERT INTO phis.support_queues (site_id, group_id, key, name, flags)
       VALUES ($1, $2, 'dev', 'Dev', 0)`,
      [site.id, groupId],
    );
    const typeRows = await pool.query<{ id: number }>(
      `INSERT INTO phis.support_ticket_types (site_id, key, name, flags, close_policy)
       VALUES ($1, 'bug', 'Bug', 0, 0)
       RETURNING id`,
      [site.id],
    );
    const requester = await createPhiTestUser(site);

    await expect(createSupportTicket({
      siteId: site.id,
      typeId: typeRows.rows[0]!.id,
      channel: 0,
      subject: "Nowhere to go",
      message: "No queue is marked as the entry.",
      requesterUserId: requester,
      createdByUserId: requester,
    })).rejects.toThrow(/No Support queue/u);
  });
});
