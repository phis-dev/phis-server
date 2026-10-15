import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";

import {
  PhisSupportClosePolicy,
  PhisSupportQueueFlag,
  PhisSupportTicketStatus,
  PhisSupportTicketTypeFlag,
  type PhisSupportForwardRequest,
} from "@phis/contracts/support";
import { PhisSiteThreadKindFlag } from "@phis/contracts/threads";
import { PhisResourceLinkFlag } from "@phis/contracts/addon";

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
  forwardSupportTicket,
  listSupportForwardTargets,
  setSupportForwardingTargetSourceForTests,
  SupportForwardError,
} from "../lib/support-forwarding";
import { createSupportTicket, getSupportTicketDetail, updateSupportTicketTask } from "./support";
import { addThreadMessage, getThreadDetail } from "./threads";
import { SUPPORT_TICKET_TASK_STATUS_DONE, SUPPORT_TICKET_TASK_STATUS_OPEN } from "../lib/constants/support";

/**
 * Handing a ticket's work to another system, and what Core does with what comes back.
 *
 * The implementation is a test double: what is asserted is Core's half -- what it hands over, what it
 * writes down, how the ticket moves when the work finishes, and what the implementation may then read.
 */

const PROVIDER_ID = "@test/forwarder";
let forwarded: PhisSupportForwardRequest[] = [];

function useTargets(targets: { providerKey: string; usable: boolean; label: string }[]) {
  setSupportForwardingTargetSourceForTests(async () => targets.map((target, index) => ({
    providerKey: target.providerKey,
    providerId: PROVIDER_ID,
    adapter: {
      probe: async () => ({ usable: target.usable, label: target.label, findings: [] }),
      forward: async (request) => {
        forwarded.push(request);
        return { type: 1, externalId: `issue-${forwarded.length}-${index}`, url: "https://example.test/1", state: 0 };
      },
    },
  })));
}

async function seed(site: PhiTestSite, type: { flags: number; closePolicy: number }) {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.site_thread_config (site_id, flags) VALUES ($1, $2)
     ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags`,
    [site.id, PhisSiteThreadKindFlag.Support],
  );
  const groupId = await createPhiTestGroup(site, "pgtest-forward-queue");
  await pool.query(
    `INSERT INTO phis.support_queues (site_id, group_id, key, name, flags) VALUES ($1, $2, 'entry', 'Entry', $3)`,
    [site.id, groupId, PhisSupportQueueFlag.Entry],
  );
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.support_ticket_types (site_id, key, name, flags, close_policy)
     VALUES ($1, 'bug', 'Bug', $2, $3) RETURNING id`,
    [site.id, type.flags, type.closePolicy],
  );
  const requester = await createPhiTestUser(site);
  const supporter = await createPhiTestUser(site);
  await addPhiTestGroupMember({ site, groupId, userId: supporter });
  return { typeId: rows[0]!.id, requester, supporter };
}

async function openTicket(site: PhiTestSite, type: { flags: number; closePolicy: number }, consent = false) {
  const seeded = await seed(site, type);
  const created = await createSupportTicket({
    siteId: site.id,
    typeId: seeded.typeId,
    channel: 0,
    subject: "Export fails",
    message: "It fails with a 500.",
    requesterUserId: seeded.requester,
    createdByUserId: seeded.requester,
    requesterExternalConsent: consent,
  });
  return { ...seeded, ticket: created!.ticket };
}

describe("support forwarding", () => {
  beforeAll(async () => {
    await dropPhiTestSites();
  });

  afterEach(() => {
    forwarded = [];
    setSupportForwardingTargetSourceForTests(null);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("offers the targets that say they are usable, by their own name", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("forward-targets");
    useTargets([
      { providerKey: "issues", usable: true, label: "Tracker acme/app" },
      { providerKey: "down", usable: false, label: "Unreachable" },
    ]);
    expect(await listSupportForwardTargets(site)).toEqual([{ providerKey: "issues", label: "Tracker acme/app" }]);
  });

  it("hands over the title alone where nothing may leave, and the ticket waits on the work", async () => {
    await requirePhiTestDatabase();
    const site = await createPhiTestSite("forward-internal");
    useTargets([{ providerKey: "issues", usable: true, label: "Tracker" }]);
    const { ticket, supporter } = await openTicket(site, { flags: 0, closePolicy: PhisSupportClosePolicy.Confirm });

    await forwardSupportTicket({ site, ticketId: ticket.id, providerKey: "issues", title: null, actorUserId: supporter });

    expect(forwarded[0]).toMatchObject({ mirror: false, body: null, task: { title: "Export fails" } });
    const detail = (await getSupportTicketDetail(site.id, ticket.id))!;
    expect(detail.ticket.status).toBe(PhisSupportTicketStatus.WaitingInternal);
    expect(detail.tasks).toHaveLength(1);
    const pool = await requirePhiTestDatabase();
    const links = await pool.query<{ provider_id: string; flags: number; ticket_task_id: number }>(
      `SELECT provider_id, flags, ticket_task_id FROM phis.resource_links WHERE site_id = $1`, [site.id],
    );
    expect(links.rows).toEqual([{
      provider_id: PROVIDER_ID,
      flags: PhisResourceLinkFlag.Synced,
      ticket_task_id: detail.tasks[0]!.id,
    }]);

    // Nothing of the conversation leaves a ticket whose type is not mirrored, so the requester's words
    // reach the implementation as a message with no text.
    const asProvider = await getThreadDetail(site.id, { kind: "provider", providerId: PROVIDER_ID }, ticket.threadId);
    expect(asProvider?.messages[0]?.bodyText).toBeNull();

    await expect(forwardSupportTicket({ site, ticketId: ticket.id, providerKey: "nowhere", title: null, actorUserId: supporter }))
      .rejects.toBeInstanceOf(SupportForwardError);
  });

  it("opens with the requester's words only where they leave and the requester agreed", async () => {
    await requirePhiTestDatabase();
    useTargets([{ providerKey: "issues", usable: true, label: "Tracker" }]);
    const external = { flags: PhisSupportTicketTypeFlag.External, closePolicy: PhisSupportClosePolicy.Confirm };

    const consentedSite = await createPhiTestSite("forward-consented");
    const consented = await openTicket(consentedSite, external, true);
    await forwardSupportTicket({ site: consentedSite, ticketId: consented.ticket.id, providerKey: "issues", title: "Bug", actorUserId: consented.supporter });
    expect(forwarded[0]).toMatchObject({ mirror: true, body: "It fails with a 500.", task: { title: "Bug" } });

    const silentSite = await createPhiTestSite("forward-silent");
    const silent = await openTicket(silentSite, external, false);
    await forwardSupportTicket({ site: silentSite, ticketId: silent.ticket.id, providerKey: "issues", title: null, actorUserId: silent.supporter });
    expect(forwarded[1]).toMatchObject({ mirror: true, body: null });

    // Mirrored, but the requester never agreed: their words stay, the Staff side leaves.
    await addThreadMessage({
      siteId: silentSite.id,
      threadId: silent.ticket.threadId,
      reader: { kind: "user", userId: silent.supporter },
      message: "We are on it.",
    });
    const asProvider = await getThreadDetail(silentSite.id, { kind: "provider", providerId: PROVIDER_ID }, silent.ticket.threadId);
    expect(asProvider?.messages.map((message) => message.bodyText)).toEqual([null, "We are on it."]);
  });

  it("moves the ticket when the forwarded work finishes or comes back", async () => {
    await requirePhiTestDatabase();
    useTargets([{ providerKey: "issues", usable: true, label: "Tracker" }]);

    const confirmSite = await createPhiTestSite("forward-confirm");
    const confirm = await openTicket(confirmSite, { flags: 0, closePolicy: PhisSupportClosePolicy.Confirm });
    const afterConfirm = await forwardSupportTicket({
      site: confirmSite, ticketId: confirm.ticket.id, providerKey: "issues", title: null, actorUserId: confirm.supporter,
    });
    const confirmTask = afterConfirm!.tasks[0]!;
    await updateSupportTicketTask({
      siteId: confirmSite.id, ticketId: confirm.ticket.id, taskId: confirmTask.id, status: SUPPORT_TICKET_TASK_STATUS_DONE,
    });
    // Under Confirm the work coming back is the Supporter's to confirm: back with Support, not closed.
    expect((await getSupportTicketDetail(confirmSite.id, confirm.ticket.id))!.ticket.status)
      .toBe(PhisSupportTicketStatus.InProgress);

    const codeSite = await createPhiTestSite("forward-code");
    const code = await openTicket(codeSite, {
      flags: PhisSupportTicketTypeFlag.CodeChange,
      closePolicy: PhisSupportClosePolicy.CodeAccepted,
    });
    const afterCode = await forwardSupportTicket({
      site: codeSite, ticketId: code.ticket.id, providerKey: "issues", title: null, actorUserId: code.supporter,
    });
    const codeTask = afterCode!.tasks[0]!;
    await updateSupportTicketTask({
      siteId: codeSite.id, ticketId: code.ticket.id, taskId: codeTask.id, status: SUPPORT_TICKET_TASK_STATUS_DONE,
    });
    // The merge is acceptance.
    expect((await getSupportTicketDetail(codeSite.id, code.ticket.id))!.ticket.status)
      .toBe(PhisSupportTicketStatus.Resolved);

    await updateSupportTicketTask({
      siteId: codeSite.id, ticketId: code.ticket.id, taskId: codeTask.id, status: SUPPORT_TICKET_TASK_STATUS_OPEN,
    });
    expect((await getSupportTicketDetail(codeSite.id, code.ticket.id))!.ticket.status)
      .toBe(PhisSupportTicketStatus.InProgress);
  });
});
