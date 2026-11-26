import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupportTicket: vi.fn(),
  getSupportTicketWithType: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/threads", () => ({ canReaderSeeThread: async () => true }));
vi.mock("@/db/server-addon-owner.mts", () => ({ isPhiSiteMember: async () => true }));
vi.mock("@/db/support-allowance", () => ({
  SupportAllowanceError: class extends Error {},
  getSupportAllowance: vi.fn(),
  grantSupportAllowance: vi.fn(),
  revokeSupportAllowanceGrant: vi.fn(),
}));
vi.mock("@/db/support", () => ({
  addSupportTicketTask: vi.fn(),
  createSupportTicket: mocks.createSupportTicket,
  findSupportTicketByThread: vi.fn(),
  getSupportQueueIdByKey: async () => 3,
  getSupportTicketDetail: vi.fn(),
  getSupportTicketIdForTask: vi.fn(),
  getSupportTicketTypeIdByKey: async () => 5,
  getSupportTicketWithType: mocks.getSupportTicketWithType,
  markSupportTicketDelivered: vi.fn(),
  setSupportTicketAwaitingDelivery: vi.fn(),
  updateSupportTicketTask: vi.fn(),
  SUPPORT_TICKET_CHANNEL_API: 4,
  SUPPORT_TICKET_CHANNEL_PORTAL: 1,
  SUPPORT_TICKET_TASK_TYPE_ENGINEERING: 2,
}));

import { buildPhisAddonSupportCapability } from "./support-capability.ts";

const capability = () => buildPhisAddonSupportCapability({ addonId: "@phis/github", siteId: 7, actorUserId: null });

/**
 * The language of a ticket's opening message, as an integration declares it.
 *
 * The capability hands it on to where the thread's first message is written, which normalizes it as it
 * does for `threads:v1` -- the refusal of an unknown key is proven against the database in
 * `support-capability.pg.test.ts`.
 */
describe("support:v1 create and the opening message's language", () => {
  beforeEach(() => {
    mocks.createSupportTicket.mockReset().mockResolvedValue({ ticket: { id: 11 } });
    mocks.getSupportTicketWithType.mockReset().mockResolvedValue({
      id: 11, threadId: 90, subject: "s", status: 0, queueId: 3,
      typeId: 5, typeKey: "request", typeFlags: 0, typeClosePolicy: 0,
      createdAt: "2026-11-26T00:00:00.000Z", updatedAt: "2026-11-26T00:00:00.000Z",
    });
  });

  it("hands a declared language on to the ticket's first message", async () => {
    await capability().create({ typeKey: "request", subject: "s", message: "Hallo.", messageSourceLang: "de_de" });
    expect(mocks.createSupportTicket).toHaveBeenCalledWith(expect.objectContaining({ messageSourceLang: "de_de" }));
  });

  it("declares nothing where the integration said nothing", async () => {
    await capability().create({ typeKey: "request", subject: "s", message: "m" });
    expect(mocks.createSupportTicket).toHaveBeenCalledWith(expect.objectContaining({ messageSourceLang: null }));
  });
});
