import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhisAddonEventContext, PhisAddonManifestV1 } from "./contract.ts";
import { deliverPhisAddonEvents } from "./event-delivery.ts";
import { digestPhisAddonManifest } from "./manifest.ts";

const state = vi.hoisted(() => ({
  entry: null as unknown, pending: [] as unknown[], handler: vi.fn(), delivered: vi.fn(), failed: vi.fn(),
  build: vi.fn(() => ({})), active: true, lockHeld: false,
}));
vi.mock("./installed.ts", () => ({ getPhisAddonInstalledManifest: () => ({ "@test/consumer": state.entry }), readPhisAddonServability: () => "ok" }));
vi.mock("./registry-state.ts", () => ({ verifyPhisAddonRegistryState: async () => state.active ? "ready" : "hidden" }));
vi.mock("./capabilities.ts", () => ({ buildPhisAddonCapabilities: (...args: unknown[]) => state.build(...args as []) }));
vi.mock("@/db/sites", () => ({ getSiteIdentityById: async () => ({ id: 1, key: "demo" }) }));
vi.mock("@/db/addon-events", () => ({ listPendingPhisAddonEvents: async () => state.pending, markPhisAddonEventDelivered: (...args: unknown[]) => state.delivered(...args),
  markPhisAddonEventFailed: (...args: unknown[]) => state.failed(...args), listPhisAddonEventAddonIds: async () => [],
  withPhisAddonEventDeliveryLock: async (_addonId: string, _siteId: number, body: () => Promise<unknown>) => state.lockHeld ? null : body() }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));

describe("owner Payment outbox delivery", () => {
  beforeEach(() => {
    const manifest: PhisAddonManifestV1 = { manifestVersion: 1, addonId: "@test/consumer", packageName: "@test/consumer", packageVersion: "0.1.0", serverAbi: "^1",
      capabilities: [], serviceProviders: [], requiredCoreCapabilities: ["@phis/server/payments:v1"], apiRoutes: [], hooks: [], jobs: [], schema: null, migrationVersion: 0,
      eventHandlers: [{ id: "payment", event: "payment.changed", handler: "changed" }, { id: "thread", event: "thread.status.changed", handler: "changed" }, { id: "asset", event: "asset.changed", handler: "changed" }] };
    state.entry = { enabled: true, manifest, manifestDigest: digestPhisAddonManifest(manifest), load: async () => ({ phisAddon: { manifest, eventHandlers: { changed: state.handler } } }) };
    state.pending = [{ id: "receipt-1", siteId: 1, addonId: manifest.addonId, event: "payment.changed", subjectKind: "payment", paymentId: "payment-1", threadId: null,
      payload: { reference: "order-1", version: 3, operationId: "operation-1", refundId: null }, attempts: 0 }];
    state.active = true; state.lockHeld = false; state.handler.mockReset(); state.build.mockClear(); state.failed.mockClear(); state.delivered.mockClear();
  });
  it("leaves the rows to the drain that holds the lock", async () => {
    state.lockHeld = true;
    expect(await deliverPhisAddonEvents({ addonId: "@test/consumer", siteId: 1 })).toEqual({ delivered: 0, failed: 0 });
    expect(state.handler).not.toHaveBeenCalled(); expect(state.delivered).not.toHaveBeenCalled();
  });
  it("delivers payment facts and its exact event authority, without manufacturing a thread", async () => {
    expect(await deliverPhisAddonEvents({ addonId: "@test/consumer", siteId: 1 })).toEqual({ delivered: 1, failed: 0 });
    const context = state.handler.mock.calls[0]![0] as PhisAddonEventContext;
    expect(context.event).toBe("payment.changed");
    expect(context.subject).toEqual({ kind: "payment", paymentId: "payment-1", reference: "order-1", version: 3, operationId: "operation-1", refundId: null });
    expect(state.build).toHaveBeenCalledWith(expect.objectContaining({ paymentAuthority: { kind: "event", id: "payment.changed" }, signal: context.signal }));
    expect(state.delivered).toHaveBeenCalledWith("receipt-1");
  });
  it("retains failed and inactive consumer delivery for a later retry", async () => {
    state.handler.mockRejectedValueOnce(new Error("Consumer fulfilment unavailable"));
    expect(await deliverPhisAddonEvents({ addonId: "@test/consumer", siteId: 1 })).toEqual({ delivered: 0, failed: 1 });
    expect(state.delivered).not.toHaveBeenCalled(); expect(state.failed).toHaveBeenCalledWith("receipt-1", "Consumer fulfilment unavailable");
    state.active = false;
    await deliverPhisAddonEvents({ addonId: "@test/consumer", siteId: 1 }); expect(state.handler).toHaveBeenCalledOnce();
    state.active = true;
    expect(await deliverPhisAddonEvents({ addonId: "@test/consumer", siteId: 1 })).toEqual({ delivered: 1, failed: 0 });
  });
  it("delivers asset.changed with its typed subject, to a handler that runs verified and without an actor", async () => {
    state.pending = [{ id: "asset-receipt", event: "asset.changed", subjectKind: "asset", paymentId: null, threadId: null,
      payload: { table: "offering", ownerId: "7", slot: "package" }, attempts: 0 }];
    expect(await deliverPhisAddonEvents({ addonId: "@test/consumer", siteId: 1 })).toEqual({ delivered: 1, failed: 0 });
    const context = state.handler.mock.calls[0]![0] as PhisAddonEventContext;
    expect(context.subject).toEqual({ kind: "asset", table: "offering", ownerId: "7", slot: "package" });
    // The capabilities are built as for any event: system authority, no actor, and never as an unverified hook.
    expect(state.build).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null, systemAuthority: true }));
    expect((state.build.mock.calls[0] as unknown[])[0]).not.toHaveProperty("unauthenticated", true);
    state.pending = [{ id: "bad", event: "asset.changed", subjectKind: "thread", paymentId: null, threadId: null, payload: {}, attempts: 0 }];
    expect((await deliverPhisAddonEvents({ addonId: "@test/consumer", siteId: 1 })).failed).toBe(1);
  });
  it("keeps thread events on the thread subject", async () => {
    state.pending = [{ id: "thread-receipt", event: "thread.status.changed", subjectKind: "thread", paymentId: null, threadId: 42, payload: {}, attempts: 0 }];
    await deliverPhisAddonEvents({ addonId: "@test/consumer", siteId: 1 });
    expect(state.handler.mock.calls[0]![0].subject).toEqual({ kind: "thread", threadId: 42, messageId: null });
  });
});
