import { beforeEach, expect, it, vi } from "vitest";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import { buildPhisPaymentsCapability } from "./runtime.ts";
import { schedulePhisAddonEventDelivery } from "../addons/event-trigger.ts";

const state = vi.hoisted(() => ({ action: vi.fn(), committed: false }));
vi.mock("../db", () => ({ getPool: () => ({}) }));
vi.mock("../addons/roles-capability.ts", () => ({ buildPhisAddonRolesCapability: () => ({}) }));
vi.mock("../addons/event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: vi.fn() }));
vi.mock("./engine.ts", () => ({ PhisPaymentEngine: class {
  listMethods = state.action; create = state.action; get = state.action; getOperation = state.action; getRefund = state.action;
  complete = state.action; refresh = state.action; capture = state.action; cancel = state.action; refund = state.action;
} }));
const api = () => buildPhisPaymentsCapability({ scope: { siteId: 17, siteKey: "demo", consumerAddonId: "@test/consumer" },
  manifest: { roles: [] } as unknown as PhisAddonManifestV1, authority: { kind: "request", operator: true, actorUserId: null }, signal: new AbortController().signal });
beforeEach(() => { vi.mocked(schedulePhisAddonEventDelivery).mockReset(); state.action.mockReset(); state.committed = false; });
it.each(["create", "complete", "refresh", "capture", "cancel", "refund"] as const)("schedules delivery only after %s commits", async method => {
  state.action.mockImplementation(async () => { expect(schedulePhisAddonEventDelivery).not.toHaveBeenCalled(); state.committed = true; return "result"; });
  expect(await (api()[method] as (...args: unknown[]) => Promise<unknown>)()).toBe("result");
  expect(state.committed).toBe(true); expect(schedulePhisAddonEventDelivery).toHaveBeenCalledWith(17);
});
it.each(["listMethods", "get", "getOperation", "getRefund"] as const)("keeps %s a read without delivery writes", async method => {
  state.action.mockResolvedValue(null); await (api()[method] as (...args: unknown[]) => Promise<unknown>)();
  expect(schedulePhisAddonEventDelivery).not.toHaveBeenCalled();
});
it("does not schedule when the operation fails before returning committed facts", async () => {
  state.action.mockRejectedValue(new Error("reservation_failed"));
  await expect(api().refresh("payment-1")).rejects.toThrow("reservation_failed");
  expect(schedulePhisAddonEventDelivery).not.toHaveBeenCalled();
});
