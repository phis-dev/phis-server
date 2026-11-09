import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  enqueue: vi.fn(async () => 2),
  deliver: vi.fn(),
  log: vi.fn(),
  installed: {} as Record<string, { enabled: boolean; manifest: { eventHandlers?: { event: string }[] } }>,
}));
vi.mock("./installed.ts", () => ({ getPhisAddonInstalledManifest: () => state.installed }));
vi.mock("./event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: (...args: unknown[]) => state.deliver(...args) }));
vi.mock("@/db/addon-events", () => ({ enqueuePhisAddonEmittedEvent: (...args: unknown[]) => state.enqueue(...(args as [])) }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: (...args: unknown[]) => state.log(...args) }));

import { buildPhisAddonEventsCapability, listPhisAddonEventListeners } from "./events-capability.ts";

const EVENT = "@acme/status:status.changed" as const;

function capability(overrides: Partial<Parameters<typeof buildPhisAddonEventsCapability>[0]> = {}) {
  return buildPhisAddonEventsCapability({
    addonId: "@acme/status",
    siteId: 7,
    siteKey: "demo",
    declared: [{ id: EVENT }],
    unauthenticated: false,
    hop: 0,
    ...overrides,
  });
}

describe("emitting an event", () => {
  beforeEach(() => {
    state.enqueue.mockClear();
    state.deliver.mockClear();
    state.log.mockClear();
    state.installed = {
      "@acme/status": { enabled: true, manifest: { eventHandlers: [{ event: EVENT }] } },
      "@acme/board": { enabled: true, manifest: { eventHandlers: [{ event: EVENT }, { event: "thread.status.changed" }] } },
      "@acme/off": { enabled: false, manifest: { eventHandlers: [{ event: EVENT }] } },
      "@acme/deaf": { enabled: true, manifest: {} },
    };
  });

  it("writes one row per listener that declares the event, at the next hop, and asks for delivery", async () => {
    const answer = await capability().emit({ event: EVENT, facts: { status: "open" }, dedupeKey: "status-1" });
    expect(answer).toEqual({ recipients: 2 });
    expect(state.enqueue).toHaveBeenCalledWith({}, {
      siteId: 7,
      emitter: "@acme/status",
      event: EVENT,
      recipients: ["@acme/status", "@acme/board"],
      facts: { status: "open" },
      dedupeKey: "status-1",
      hop: 1,
    });
    expect(state.deliver).toHaveBeenCalledWith(7);
  });

  it("keeps a self-addressed event to the emitter", () => {
    expect(listPhisAddonEventListeners(EVENT, { id: EVENT, audience: "self" }, "@acme/status")).toEqual(["@acme/status"]);
    expect(listPhisAddonEventListeners(EVENT, { id: EVENT }, "@acme/status")).toEqual(["@acme/status", "@acme/board"]);
  });

  it("asks for no delivery where nobody listens", async () => {
    state.enqueue.mockResolvedValueOnce(0);
    expect(await capability().emit({ event: EVENT })).toEqual({ recipients: 0 });
    expect(state.deliver).not.toHaveBeenCalled();
  });

  it("refuses an undeclared event, an unverified hook, bad facts and a bad key", async () => {
    await expect(capability().emit({ event: "@acme/status:other" })).rejects.toThrow(/declares no event/);
    await expect(capability({ unauthenticated: true }).emit({ event: EVENT })).rejects.toThrow(/unverified hook/);
    await expect(capability().emit({ event: EVENT, facts: [] as never })).rejects.toThrow(/facts must be an object/);
    await expect(capability().emit({ event: EVENT, facts: { big: "x".repeat(20_000) } })).rejects.toThrow(/at most/);
    await expect(capability().emit({ event: EVENT, dedupeKey: "has space" })).rejects.toThrow(/dedupeKey/);
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it("refuses an emit at the hop limit and logs it, instead of chaining forever", async () => {
    await expect(capability({ hop: 4 }).emit({ event: EVENT })).rejects.toThrow(/at most 4 handlers/);
    expect(state.log).toHaveBeenCalledWith("warn", "addon.event.hop_limit", expect.objectContaining({ pluginKey: "@acme/status" }));
    expect(state.enqueue).not.toHaveBeenCalled();
  });
});
