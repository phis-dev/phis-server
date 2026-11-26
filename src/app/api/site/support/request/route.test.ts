import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteAuthenticatedApiContext: async () => ({
    context: { site: { id: 1, key: "acme" }, session: { userId: 7 } },
    error: null,
  }),
}));
vi.mock("@/db/support", () => ({
  SUPPORT_TICKET_CHANNEL_PORTAL: 1,
  createSupportTicket: mocks.create,
  getRequestableSupportTicketType: async () => ({ id: 3, external: false }),
  hasSupportEntryQueue: async () => true,
}));
vi.mock("@/db/support-allowance", () => ({ SupportAllowanceExhaustedError: class extends Error {} }));

import { POST } from "./route";

function ask(extra: Record<string, unknown>) {
  return POST(new NextRequest("https://server.test/api/site/support/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ typeKey: "billing", subject: "Rechnung", message: "Hallo.", ...extra }),
  }));
}

/** The person asking declares what their first message is written in, as on every other message route. */
describe("a request's first message language", () => {
  beforeEach(() => {
    mocks.create.mockResolvedValue({ ticket: { id: 11, threadId: 5 } });
  });

  it("is handed to the ticket's thread as it resolves", async () => {
    expect((await ask({ sourceLang: "de_AT" })).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ messageSourceLang: "de-AT" }));
  });

  it("is nothing where nothing was declared", async () => {
    expect((await ask({})).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ messageSourceLang: null }));
  });

  it("refuses a key nobody knows before a ticket is opened or an allowance spent", async () => {
    for (const sourceLang of ["xx", 7]) {
      expect((await ask({ sourceLang })).status).toBe(400);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
