import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  membership: vi.fn(),
  attempt: vi.fn(),
}));

vi.mock("@/db/notifications", () => ({ enqueuePhiNotification: mocks.enqueue }));
vi.mock("@/db/user-site-memberships", () => ({ getUserSiteMembership: mocks.membership }));
vi.mock("@/lib/notifications/deliver", () => ({ attemptPhiNotificationNow: mocks.attempt }));

import type { PhisAddonOccasionDescriptor } from "./contract.ts";
import { buildPhisAddonNotificationsCapability } from "./notifications-capability.ts";

/**
 * What `notify` lets through, and what it refuses before anything is written.
 *
 * The outbox is Core's record; what is tested here is the gate in front of it -- that an Add-on can
 * only ask for an occasion it declared, with the parameters it declared, to a person Core can reach.
 */

const orderPaid: PhisAddonOccasionDescriptor = {
  name: "order-paid",
  class: "asked-for",
  subject: { text: "Order %1 is paid", parameters: ["number"] },
  lines: [{ text: "Follow it here: %1", parameters: ["link"] }],
  parameters: [
    { name: "number", type: "text" },
    { name: "link", type: "path" },
  ],
};

function capability(unauthenticated = false) {
  return buildPhisAddonNotificationsCapability({
    addonId: "@acme/shop",
    siteId: 7,
    declared: [orderPaid],
    unauthenticated,
  });
}

const params = { number: "1001", link: "/shop/order/1001" };

describe("notifications capability", () => {
  beforeEach(() => {
    mocks.enqueue.mockReset().mockResolvedValue("42");
    mocks.membership.mockReset().mockResolvedValue({ enabled: true });
    mocks.attempt.mockReset().mockResolvedValue(undefined);
  });

  it("writes a contact's message under the Add-on's id, keeps the name beside the parameters, and attempts it", async () => {
    const result = await capability().notify({
      occasion: "order-paid",
      recipient: { kind: "contact", address: "guest@example.com", locale: "de", name: "Guest" },
      params,
      dedupeKey: "order-1001-paid",
    });
    expect(result).toEqual({ notificationId: "42" });
    expect(mocks.enqueue).toHaveBeenCalledWith({
      siteId: 7,
      occasion: "order-paid",
      recipient: { address: "guest@example.com", locale: "de" },
      providerId: "@acme/shop",
      flags: 0,
      params: { ...params, recipientName: "Guest" },
      dedupeKey: expect.stringMatching(/^addon:[0-9a-f]{64}$/),
    });
    expect(mocks.attempt).toHaveBeenCalledWith("42");
  });

  it("writes to a member by id and never to somebody who is not on this Site", async () => {
    await capability().notify({ occasion: "order-paid", recipient: { kind: "user", userId: 5 }, params });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ recipient: { userId: 5, locale: null } }));
    expect(mocks.membership).toHaveBeenCalledWith(5, 7);

    mocks.membership.mockResolvedValue(null);
    await expect(capability().notify({ occasion: "order-paid", recipient: { kind: "user", userId: 6 }, params }))
      .rejects.toThrow(/not a member/);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it("refuses an occasion the Add-on did not declare", async () => {
    await expect(capability().notify({ occasion: "order-shipped", recipient: { kind: "user", userId: 5 }, params }))
      .rejects.toThrow(/declares no occasion "order-shipped"/);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("requires exactly the declared parameters", async () => {
    const recipient = { kind: "user", userId: 5 } as const;
    await expect(capability().notify({ occasion: "order-paid", recipient, params: { number: "1" } }))
      .rejects.toThrow(/"link".*missing/);
    await expect(capability().notify({ occasion: "order-paid", recipient, params: { ...params, total: "x" } }))
      .rejects.toThrow(/no parameter "total"/);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("takes a path and not a URL for a link", async () => {
    const recipient = { kind: "user", userId: 5 } as const;
    for (const link of ["https://evil.example/x", "//evil.example/x", "shop/order/1", "/shop/order 1"]) {
      await expect(capability().notify({ occasion: "order-paid", recipient, params: { ...params, link } }))
        .rejects.toThrow(/Site-relative path/);
    }
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("requires a locale and a real address for a contact", async () => {
    await expect(capability().notify({
      occasion: "order-paid",
      recipient: { kind: "contact", address: "guest@example.com", locale: "" as string },
      params,
    })).rejects.toThrow(/locale/);
    await expect(capability().notify({
      occasion: "order-paid",
      recipient: { kind: "contact", address: "not an address", locale: "de" },
      params,
    })).rejects.toThrow(/email address/);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("answers null without an attempt when the dedupe key was already used", async () => {
    mocks.enqueue.mockResolvedValue(null);
    const result = await capability().notify({
      occasion: "order-paid",
      recipient: { kind: "user", userId: 5 },
      params,
      dedupeKey: "order-1001-paid",
    });
    expect(result).toEqual({ notificationId: null });
    expect(mocks.attempt).not.toHaveBeenCalled();
  });

  it("lets an unverified hook write to nobody", async () => {
    await expect(capability(true).notify({ occasion: "order-paid", recipient: { kind: "user", userId: 5 }, params }))
      .rejects.toThrow(/unverified hook/);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
