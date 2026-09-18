import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PhisSupportQueueFlag,
  PhisSupportTicketTypeFlag,
} from "@phis/contracts/support";
import { PhisResourceLinkFlag } from "@phis/contracts/resource-links";
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
import { createSupportTicket } from "./support";
import { upsertResourceLink } from "./resource-links";
import { buildPhisAddonSupportCapability } from "@/lib/addons/support-capability";

const configured = process.env.PHIS_PG_TEST === "1";
const ADDON = "@phis/github";

/**
 * What an Add-on may see of a Site's Support work, and what it may not.
 *
 * The capability exists so a package in its own repository can reach tickets without depending on
 * `@phis/support`, and the whole of its safety is that reach is the thread's answer rather than a second
 * rule over the ticket row. So these are the cases that would distinguish the two.
 */
describe.skipIf(!configured)("support capability", () => {
  let site: PhiTestSite;
  let queueId: number;
  let typeId: number;
  let supporter: number;

  async function openTicket(subject: string, ownerProviderId?: string) {
    const created = await createSupportTicket({
      siteId: site.id,
      typeId,
      queueId,
      channel: 0,
      subject,
      message: "opened by the test",
      ownerProviderId: ownerProviderId ?? null,
    });
    return created!.ticket;
  }

  /** With nobody behind it, which is how a hook or a job reaches anything. */
  const actorless = () => buildPhisAddonSupportCapability({
    addonId: ADDON,
    siteId: site.id,
    actorUserId: null,
  });

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("support-cap");
    await pool.query(
      `INSERT INTO phis.site_thread_config (site_id, flags) VALUES ($1, $2)
       ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags`,
      [site.id, PhisSiteThreadKindFlag.Support],
    );
    const groupId = await createPhiTestGroup(site, "pgtest-support-cap");
    supporter = await createPhiTestUser(site);
    await addPhiTestGroupMember({ site, groupId, userId: supporter });
    const queues = await pool.query<{ id: number }>(
      `INSERT INTO phis.support_queues (site_id, group_id, key, name, flags)
       VALUES ($1, $2, 'entry', 'Support', $3) RETURNING id`,
      [site.id, groupId, PhisSupportQueueFlag.Entry],
    );
    queueId = queues.rows[0]!.id;
    const types = await pool.query<{ id: number }>(
      `INSERT INTO phis.support_ticket_types (site_id, key, name, flags, close_policy)
       VALUES ($1, 'request', 'Request', $2, 0) RETURNING id`,
      [site.id, PhisSupportTicketTypeFlag.External],
    );
    typeId = types.rows[0]!.id;
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("reaches nothing it neither opened nor was linked to", async () => {
    const ticket = await openTicket("somebody else's work");
    expect(await actorless().get(ticket.id)).toBeNull();
    expect(await actorless().findByThread(ticket.threadId)).toBeNull();
    // Absent and out of reach end the same way, so asking does not reveal that a ticket exists.
    await expect(actorless().listTasks(ticket.id)).rejects.toThrow(/cannot reach/);
  });

  it("reaches what it opened, and is told the type it has to decide from", async () => {
    const ticket = await openTicket("arrived from the repository", ADDON);
    const read = await actorless().get(ticket.id);
    expect(read).not.toBeNull();
    // The flags are what says whether anything may leave the Site at all.
    expect(read!.type).toMatchObject({ key: "request", flags: PhisSupportTicketTypeFlag.External });
    expect(read!.threadId).toBe(ticket.threadId);
    expect(await actorless().findByThread(ticket.threadId)).toMatchObject({ id: ticket.id });
  });

  it("reaches a ticket somebody linked to it, and loses it when the link stops being synced", async () => {
    const ticket = await openTicket("linked by a person");
    const link = await upsertResourceLink({
      siteId: site.id,
      providerId: ADDON,
      subject: { kind: "ticket", id: ticket.id },
      type: 1,
      externalId: "issue-1",
      flags: PhisResourceLinkFlag.Synced,
      createdByUserId: supporter,
    });
    expect(await actorless().get(ticket.id)).toMatchObject({ id: ticket.id });

    const pool = await requirePhiTestDatabase();
    await pool.query(`UPDATE phis.resource_links SET flags = 0 WHERE id = $1`, [link.id]);
    // The link is the consent, so withdrawing it ends the reach rather than merely hiding a pointer.
    expect(await actorless().get(ticket.id)).toBeNull();
  });

  it("records work on a ticket it reaches, and moves the task without moving the ticket", async () => {
    const ticket = await openTicket("work to do", ADDON);
    const capability = actorless();
    const task = await capability.addTask({ ticketId: ticket.id, type: 2, title: "Fix the export" });
    expect(await capability.listTasks(ticket.id)).toHaveLength(1);

    const moved = await capability.setTaskStatus({ taskId: task.id, status: 3 });
    expect(moved.status).toBe(3);
    // An issue completes its task; whether that finishes the Support work is the ticket's own rule,
    // and this capability offers no way to decide it from outside.
    expect((await capability.get(ticket.id))!.status).toBe(ticket.status);
    expect("setStatus" in capability).toBe(false);
  });

  it("refuses everything to an unverified hook", async () => {
    const ticket = await openTicket("not for an unsigned caller", ADDON);
    const unsigned = buildPhisAddonSupportCapability({
      addonId: ADDON,
      siteId: site.id,
      actorUserId: null,
      unauthenticated: true,
    });
    // Reads included: a ticket says what a Site is working on for a customer.
    await expect(unsigned.get(ticket.id)).rejects.toThrow(/unverified hook/);
    await expect(unsigned.findByThread(ticket.threadId)).rejects.toThrow(/unverified hook/);
  });

  it("refuses a type or a queue this Site does not have", async () => {
    await expect(actorless().create({
      typeKey: "nonesuch", subject: "s", message: "m",
    })).rejects.toThrow(/does not have/);
    await expect(actorless().create({
      typeKey: "request", queueKey: "nonesuch", subject: "s", message: "m",
    })).rejects.toThrow(/does not have/);
  });
});
