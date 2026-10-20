import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ apply: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteSupportApiContext: async () => ({
    context: { site: { id: 1, key: "acme" }, session: { userId: 7 } },
    error: null,
  }),
}));
// Within reach: what is under test here is how the route reads its input, not whose ticket it is.
vi.mock("@/lib/support-reach", () => ({ readSupportTicketReach: () => ({}) }));
vi.mock("@/db/support", () => ({
  applySupportTicketAssignmentAction: mocks.apply,
  supportTicketWithinReach: async () => true,
}));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));

import { POST } from "./route";

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("https://server.test/api/site/support/tickets/5/assignment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ ticketId: "5" }) },
  );
}

/**
 * The ids an assignment names are read the way the ticket id is: a value that is not one names nothing,
 * rather than being cut down to the number it starts with.
 */
describe("ticket assignment", () => {
  beforeEach(() => {
    mocks.apply.mockReset();
    mocks.apply.mockResolvedValue({ id: 5 });
  });

  it("refuses a queue id that is not one, instead of reading its leading digits", async () => {
    for (const queueId of ["12abc", "1.5", -3, 0, undefined]) {
      expect((await post({ action: "move_to_queue", queueId })).status).toBe(400);
    }
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("refuses a target user id that is not one", async () => {
    expect((await post({ action: "assign_to_user", targetUserId: "9x" })).status).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("passes a valid id through, as a number or as digits", async () => {
    await post({ action: "move_to_queue", queueId: "12" });
    await post({ action: "assign_to_user", targetUserId: 9 });
    expect(mocks.apply.mock.calls.map(([input]) => input.queueId ?? input.targetUserId)).toEqual([12, 9]);
  });
});
