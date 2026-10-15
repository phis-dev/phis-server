import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteSupportApiContext: async () => ({
    context: { site: { id: 1, key: "acme" }, session: { userId: 7 } },
    error: null,
  }),
}));
vi.mock("@/db/support-ticket-events", () => ({ listSupportTicketEvents: mocks.list }));

import { GET } from "./route";

function get(ticketId: string) {
  return GET(
    new NextRequest(`https://server.test/api/site/support/tickets/${ticketId}/events`),
    { params: Promise.resolve({ ticketId }) },
  );
}

/** A ticket's history is read within the Site, by an id that is one. */
describe("ticket events", () => {
  beforeEach(() => {
    mocks.list.mockReset();
  });

  it("answers the events of a ticket of this Site", async () => {
    mocks.list.mockResolvedValue([{ id: 1, kind: "created", at: "2026-10-15T10:00:00.000Z", actor: null }]);
    const response = await get("5");
    expect(response.status).toBe(200);
    expect((await response.json()).events).toHaveLength(1);
    expect(mocks.list).toHaveBeenCalledWith(1, 5);
  });

  it("answers 404 for a ticket the Site does not have", async () => {
    mocks.list.mockResolvedValue(null);
    expect((await get("9")).status).toBe(404);
  });

  it("refuses an id that is not one", async () => {
    for (const ticketId of ["0", "5x", "-1"]) {
      expect((await get(ticketId)).status).toBe(400);
    }
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
