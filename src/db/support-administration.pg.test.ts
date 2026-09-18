import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PhisSupportQueueFlag, PhisSupportTicketTypeFlag } from "@phis/contracts/support";

import {
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  SupportAdministrationError,
  createSupportQueue,
  createSupportTicketType,
  listSupportQueues,
  listSupportTicketTypes,
  updateSupportQueue,
  updateSupportTicketType,
} from "./support";

const configured = process.env.PHIS_PG_TEST === "1";

/**
 * Administering queues and types, which is everything the declared seed deliberately does not do.
 *
 * The seed makes a Site able to answer anybody at all; this is what a Site does afterwards. The rules
 * worth asserting are the ones that keep it from administering itself into a state where it answers
 * nobody -- and the one that keeps an edit from colliding with the seed on the next publish.
 */
describe.skipIf(!configured)("support administration", () => {
  let site: PhiTestSite;
  let groupId: number;
  let entryQueueId: number;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("support-admin");
    groupId = await createPhiTestGroup(site, "pgtest-support-admin");
    entryQueueId = await createSupportQueue({
      siteId: site.id,
      groupId,
      key: "entry",
      name: "Support",
      flags: PhisSupportQueueFlag.Entry,
    });
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("refuses a second queue under a key the Site already uses", async () => {
    await expect(createSupportQueue({
      siteId: site.id, groupId, key: "entry", name: "Another",
    })).rejects.toThrow(SupportAdministrationError);
  });

  it("refuses a queue routed at a group this Site does not have", async () => {
    await expect(createSupportQueue({
      siteId: site.id, groupId: 999_999, key: "nowhere", name: "Nowhere",
    })).rejects.toThrow(/does not have/);
  });

  it("leaves exactly one entry queue when the mark moves", async () => {
    const second = await createSupportQueue({
      siteId: site.id, groupId, key: "billing", name: "Billing",
    });
    await updateSupportQueue({
      siteId: site.id, queueId: second, flags: PhisSupportQueueFlag.Entry,
    });

    const queues = await listSupportQueues(site.id);
    const marked = queues.filter((queue) => (queue.flags & PhisSupportQueueFlag.Entry) !== 0);
    // The read that resolves routing takes the first row it finds, so two marks is not a richer
    // configuration -- it is a Site whose routing depends on sort_order.
    expect(marked.map((queue) => queue.id)).toEqual([second]);

    await updateSupportQueue({
      siteId: site.id, queueId: entryQueueId, flags: PhisSupportQueueFlag.Entry,
    });
  });

  it("will not let a Site retire or unmark its last way in", async () => {
    await expect(updateSupportQueue({
      siteId: site.id, queueId: entryQueueId, retired: true,
    })).rejects.toThrow(/entry queue cannot be retired/);
    await expect(updateSupportQueue({
      siteId: site.id, queueId: entryQueueId, flags: 0,
    })).rejects.toThrow(/needs an entry queue/);
  });

  it("retires a queue that is not the way in, and keeps it listed", async () => {
    const queueId = await createSupportQueue({
      siteId: site.id, groupId, key: "old", name: "Old",
    });
    await updateSupportQueue({ siteId: site.id, queueId, retired: true });

    const retired = (await listSupportQueues(site.id)).find((queue) => queue.id === queueId);
    // Retirement replaces deletion: whoever administers the catalogue has to see what tickets still name.
    expect(retired?.retiredAt).not.toBeNull();

    await updateSupportQueue({ siteId: site.id, queueId, retired: false });
    expect((await listSupportQueues(site.id)).find((queue) => queue.id === queueId)?.retiredAt).toBeNull();
  });

  it("edits a name and never a key", async () => {
    await updateSupportQueue({ siteId: site.id, queueId: entryQueueId, name: "Kundendienst" });
    const queue = (await listSupportQueues(site.id)).find((row) => row.id === entryQueueId);
    expect(queue).toMatchObject({ name: "Kundendienst", key: "entry" });
  });

  it("marks a type requestable, which is the decision the Site takes and never inherits", async () => {
    const typeId = await createSupportTicketType({
      siteId: site.id, key: "request", name: "Request",
    });
    expect((await listSupportTicketTypes(site.id))[0]).toMatchObject({ flags: 0 });

    await updateSupportTicketType({
      siteId: site.id, typeId, flags: PhisSupportTicketTypeFlag.Requestable,
    });
    const type = (await listSupportTicketTypes(site.id)).find((row) => row.id === typeId);
    expect(type!.flags & PhisSupportTicketTypeFlag.Requestable).not.toBe(0);
  });

  it("refuses a type that waits for a merge without being a code change", async () => {
    await expect(createSupportTicketType({
      siteId: site.id, key: "waits", name: "Waits", closePolicy: 1,
    })).rejects.toThrow(/close_policy_check/);
  });
});
