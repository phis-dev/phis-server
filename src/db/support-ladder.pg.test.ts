import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
  PhisSupportQueueFlag,
  PhisSupportTicketStatus,
} from "@phis/contracts/support";
import { PhisSiteThreadKindFlag, PhisThreadMessageFlag } from "@phis/contracts/threads";

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
import { PHI_MAINTENANCE_TASKS } from "../cli/maintain.mts";
import {
  applySupportTicketAssignmentAction,
  createSupportTicket,
  getSupportTicketDetail,
  listSupportTicketsForSite,
  markSupportTicketDelivered,
  setSupportRequesterWindowDays,
  setSupportTicketAwaitingDelivery,
  SupportAdministrationError,
  updateSupportTicket,
} from "./support";
import { addThreadMessage } from "./threads";

/**
 * The ladder moves because something happened, not only because somebody set a status.
 *
 * Taking a ticket assigns it, the first answer starts the work, resolving starts the requester's window,
 * the requester answering reopens it, and silence for the whole window closes it.
 */

async function seedSupport(site: PhiTestSite, windowDays: { site?: number; type?: number | null } = {}) {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.site_thread_config (site_id, flags, requester_window_days)
     VALUES ($1, $2, $3)
     ON CONFLICT (site_id) DO UPDATE
       SET flags = EXCLUDED.flags, requester_window_days = EXCLUDED.requester_window_days`,
    [site.id, PhisSiteThreadKindFlag.Support, windowDays.site ?? 14],
  );
  const groupId = await createPhiTestGroup(site, "pgtest-ladder-queue");
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.support_queues (site_id, group_id, key, name, flags)
     VALUES ($1, $2, 'entry', 'Entry', $3)
     RETURNING id`,
    [site.id, groupId, PhisSupportQueueFlag.Entry],
  );
  const typeRows = await pool.query<{ id: number }>(
    `INSERT INTO phis.support_ticket_types (site_id, key, name, flags, close_policy, requester_window_days)
     VALUES ($1, 'request', 'Request', 0, 0, $2)
     RETURNING id`,
    [site.id, windowDays.type ?? null],
  );
  return { groupId, queueId: rows[0]!.id, typeId: typeRows.rows[0]!.id };
}

async function openTicket(site: PhiTestSite, windowDays?: { site?: number; type?: number | null }) {
  const { groupId, typeId } = await seedSupport(site, windowDays);
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
  return { ticket: created!.ticket, requester, supporter };
}

async function readTicket(siteId: number, ticketId: number) {
  return (await getSupportTicketDetail(siteId, ticketId))!.ticket;
}

async function runRequesterWindow() {
  const pool = await requirePhiTestDatabase();
  const task = PHI_MAINTENANCE_TASKS.find((candidate) => candidate.id === "support-requester-window")!;
  return task.run(pool, { dryRun: false });
}

async function ageResolution(ticketId: number, days: number) {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `UPDATE phis.support_tickets SET resolved_at = NOW() - make_interval(days => $2) WHERE id = $1`,
    [ticketId, days],
  );
}

describe("support ticket ladder", () => {
  beforeAll(async () => {
    await dropPhiTestSites();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("assigns on taking, starts on the first answer, and goes back on putting down", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("ladder-handover");
    const { ticket, supporter } = await openTicket(site);
    expect(ticket.status).toBe(PhisSupportTicketStatus.New);

    await applySupportTicketAssignmentAction({
      siteId: site.id, ticketId: ticket.id, action: "assign_to_me", userId: supporter,
    });
    expect((await readTicket(site.id, ticket.id)).status).toBe(PhisSupportTicketStatus.Assigned);

    await applySupportTicketAssignmentAction({
      siteId: site.id, ticketId: ticket.id, action: "unassign", userId: supporter,
    });
    expect((await readTicket(site.id, ticket.id)).status).toBe(PhisSupportTicketStatus.Triaged);

    await applySupportTicketAssignmentAction({
      siteId: site.id, ticketId: ticket.id, action: "assign_to_me", userId: supporter,
    });
    // A note among Staff is not an answer to the requester.
    await addThreadMessage({
      siteId: site.id,
      threadId: ticket.threadId,
      reader: { kind: "user", userId: supporter },
      message: "Looks like the CSV writer.",
      messageFlags: PhisThreadMessageFlag.Internal,
    });
    await addThreadMessage({
      siteId: site.id,
      threadId: ticket.threadId,
      reader: { kind: "user", userId: supporter },
      message: "We are looking into it.",
    });
    const started = await readTicket(site.id, ticket.id);
    expect(started.status).toBe(PhisSupportTicketStatus.InProgress);
    expect(started.lastPublicMessageAt).not.toBeNull();

    // Further along than taken, a change of hands leaves the ticket where it is.
    await applySupportTicketAssignmentAction({
      siteId: site.id, ticketId: ticket.id, action: "unassign", userId: supporter,
    });
    expect((await readTicket(site.id, ticket.id)).status).toBe(PhisSupportTicketStatus.InProgress);
  });

  it("reopens a resolved ticket when the requester answers", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("ladder-reopen");
    const { ticket, requester, supporter } = await openTicket(site);

    await updateSupportTicket({
      siteId: site.id, ticketId: ticket.id, status: PhisSupportTicketStatus.Resolved, updatedByUserId: supporter,
    });
    const resolved = await readTicket(site.id, ticket.id);
    expect(resolved.status).toBe(PhisSupportTicketStatus.Resolved);
    expect(resolved.resolvedAt).not.toBeNull();

    await addThreadMessage({
      siteId: site.id,
      threadId: ticket.threadId,
      reader: { kind: "user", userId: requester },
      message: "Still broken here.",
    });
    const reopened = await readTicket(site.id, ticket.id);
    expect(reopened.status).toBe(PhisSupportTicketStatus.InProgress);
    expect(reopened.resolvedAt).toBeNull();
  });

  it("writes down the close for a ticket nobody touches again, through phis maintain", async () => {
    const site = await createPhiTestSite("ladder-window");
    const { ticket, supporter } = await openTicket(site);
    await updateSupportTicket({
      siteId: site.id, ticketId: ticket.id, status: PhisSupportTicketStatus.Resolved, updatedByUserId: supporter,
    });

    const pool = await requirePhiTestDatabase();
    const storedStatus = async () => (await pool.query<{ status: number }>(
      `SELECT status FROM phis.support_tickets WHERE id = $1`, [ticket.id],
    )).rows[0]?.status;

    await ageResolution(ticket.id, 13);
    await runRequesterWindow();
    expect(await storedStatus()).toBe(PhisSupportTicketStatus.Resolved);

    await ageResolution(ticket.id, 15);
    await runRequesterWindow();
    expect(await storedStatus()).toBe(PhisSupportTicketStatus.Closed);
  });

  it("reads a ticket past its window as closed and keeps it closed, without phis maintain", async () => {
    const pool = await requirePhiTestDatabase();
    const site = await createPhiTestSite("ladder-settled");
    const { ticket, requester, supporter } = await openTicket(site);
    await updateSupportTicket({
      siteId: site.id, ticketId: ticket.id, status: PhisSupportTicketStatus.Resolved, updatedByUserId: supporter,
    });
    await ageResolution(ticket.id, 15);

    // Nothing has written anything; every read already answers closed, closed when the window ended.
    const read = await readTicket(site.id, ticket.id);
    expect(read.status).toBe(PhisSupportTicketStatus.Closed);
    expect(read.closedAt).not.toBeNull();
    const listed = await listSupportTicketsForSite(site.id, { status: PhisSupportTicketStatus.Closed });
    expect(listed.rows.map((row) => row.id)).toContain(ticket.id);
    const stored = await pool.query<{ status: number }>(
      `SELECT status FROM phis.support_tickets WHERE id = $1`, [ticket.id],
    );
    expect(stored.rows[0]?.status).toBe(PhisSupportTicketStatus.Resolved);

    // An answer after the window answers a closed ticket: it is written down as closed, not reopened.
    await addThreadMessage({
      siteId: site.id,
      threadId: ticket.threadId,
      reader: { kind: "user", userId: requester },
      message: "Oh, and one more thing.",
    });
    const after = await pool.query<{ status: number; closed_at: string | null }>(
      `SELECT status, closed_at FROM phis.support_tickets WHERE id = $1`, [ticket.id],
    );
    expect(after.rows[0]?.status).toBe(PhisSupportTicketStatus.Closed);
    expect(after.rows[0]?.closed_at).not.toBeNull();
  });

  it("leaves the closing to a Supporter where the type or the Site waits for one", async () => {
    await requirePhiTestDatabase();
    const typeSite = await createPhiTestSite("ladder-type-waits");
    const siteSite = await createPhiTestSite("ladder-site-waits");
    const waiting = [
      { site: typeSite, ...await openTicket(typeSite, { type: 0 }) },
      { site: siteSite, ...await openTicket(siteSite, { site: 0, type: 3 }) },
    ];
    for (const { site, ticket, supporter } of waiting) {
      await updateSupportTicket({
        siteId: site.id, ticketId: ticket.id, status: PhisSupportTicketStatus.Resolved, updatedByUserId: supporter,
      });
      await ageResolution(ticket.id, 60);
    }

    await runRequesterWindow();
    for (const { site, ticket } of waiting) {
      expect((await readTicket(site.id, ticket.id)).status).toBe(PhisSupportTicketStatus.Resolved);
    }
  });

  it("takes the Site's window from the catalogue's settings, and 0 stops the closing", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("ladder-site-setting");
    const { ticket, supporter } = await openTicket(site);
    await updateSupportTicket({
      siteId: site.id, ticketId: ticket.id, status: PhisSupportTicketStatus.Resolved, updatedByUserId: supporter,
    });
    await ageResolution(ticket.id, 20);
    expect((await readTicket(site.id, ticket.id)).status).toBe(PhisSupportTicketStatus.Closed);

    await setSupportRequesterWindowDays(site.id, 0);
    expect((await readTicket(site.id, ticket.id)).status).toBe(PhisSupportTicketStatus.Resolved);

    await setSupportRequesterWindowDays(site.id, 30);
    expect((await readTicket(site.id, ticket.id)).status).toBe(PhisSupportTicketStatus.Resolved);
    await expect(setSupportRequesterWindowDays(site.id, -1)).rejects.toThrow(SupportAdministrationError);
  });

  it("holds the window of a resolved ticket until its fix is delivered, then counts from the delivery", async () => {
    const pool = await requirePhiTestDatabase();
    const site = await createPhiTestSite("ladder-delivery");
    const { ticket, supporter } = await openTicket(site);
    // Not resolved: there is no window to hold.
    expect(await setSupportTicketAwaitingDelivery(site.id, ticket.id)).toBe(false);

    await updateSupportTicket({
      siteId: site.id, ticketId: ticket.id, status: PhisSupportTicketStatus.Resolved, updatedByUserId: supporter,
    });
    expect(await setSupportTicketAwaitingDelivery(site.id, ticket.id)).toBe(true);
    await ageResolution(ticket.id, 40);
    expect((await readTicket(site.id, ticket.id)).status).toBe(PhisSupportTicketStatus.Resolved);

    expect(await markSupportTicketDelivered(site.id, ticket.id)).toBe(true);
    expect(await markSupportTicketDelivered(site.id, ticket.id)).toBe(false);
    expect((await readTicket(site.id, ticket.id)).status).toBe(PhisSupportTicketStatus.Resolved);

    await pool.query(
      `UPDATE phis.support_tickets SET delivered_at = NOW() - make_interval(days => 15) WHERE id = $1`,
      [ticket.id],
    );
    expect((await readTicket(site.id, ticket.id)).status).toBe(PhisSupportTicketStatus.Closed);
  });
});
