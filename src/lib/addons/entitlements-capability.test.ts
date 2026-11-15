import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  deliver: vi.fn(),
  installed: {} as Record<string, { enabled: boolean; manifest: { entitlementKinds?: unknown[]; eventHandlers?: { event: string }[] } }>,
  ensureSubject: vi.fn(async () => "sub_actor"),
  findSubject: vi.fn(async (): Promise<{ id: number; userId: number } | null> => ({ id: 5, userId: 9 })),
  grant: vi.fn(async (input: Record<string, unknown>) => ({ ...input, id: 1 })),
  update: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ ...input, id: 1 })),
  list: vi.fn(async () => []),
  readState: vi.fn(async (input: Record<string, unknown>) => ({ kind: input.kind, entitled: input.subjectId !== null, quantity: null, until: null })),
  allowed: vi.fn(async () => false),
}));
vi.mock("./installed.ts", () => ({ getPhisAddonInstalledManifest: () => state.installed }));
vi.mock("./event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: (...args: unknown[]) => state.deliver(...args) }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/entitlements.mts", () => ({
  ensureEntitlementSubject: (_pool: unknown, ...args: unknown[]) => state.ensureSubject(...(args as [])),
  findEntitlementSubject: (_pool: unknown, ...args: unknown[]) => state.findSubject(...(args as [])),
  grantEntitlement: (_pool: unknown, input: Record<string, unknown>) => state.grant(input),
  updateEntitlement: (_pool: unknown, input: Record<string, unknown>) => state.update(input),
  listEntitlements: (_pool: unknown, ...args: unknown[]) => state.list(...(args as [])),
  readEntitlementState: (_pool: unknown, input: Record<string, unknown>) => state.readState(input),
  isEntitlementSourceAllowed: (_pool: unknown, ...args: unknown[]) => state.allowed(...(args as [])),
}));


import { buildPhisAddonEntitlementsCapability, listPhisEntitlementKinds, listPhisEntitlementListeners } from "./entitlements-capability.ts";

const LICENSE = "@acme/licenses:pro";
const SEATS = "@acme/licenses:seats";
const SHOP = "@acme/shop";

function capability(overrides: Partial<Parameters<typeof buildPhisAddonEntitlementsCapability>[0]> = {}) {
  return buildPhisAddonEntitlementsCapability({ addonId: SHOP, siteId: 7, actorUserId: 9, unauthenticated: false, ...overrides });
}

describe("entitlements capability", () => {
  beforeEach(() => {
    state.installed = {
      "@acme/licenses": {
        enabled: true,
        manifest: {
          entitlementKinds: [{ key: "pro", title: "Pro" }, { key: "seats", title: "Seats", description: "Per seat", counted: true }],
          eventHandlers: [{ event: "entitlement.changed" }],
        },
      },
      "@acme/shop": { enabled: true, manifest: {} },
      "@acme/off": { enabled: false, manifest: { entitlementKinds: [{ key: "hidden", title: "Hidden" }], eventHandlers: [{ event: "entitlement.changed" }] } },
    };
    state.allowed.mockResolvedValue(false);
    state.findSubject.mockResolvedValue({ id: 5, userId: 9 });
  });

  it("takes the kinds from enabled manifests only", async () => {
    expect(listPhisEntitlementKinds().map((kind) => kind.id)).toEqual([LICENSE, SEATS]);
    expect(listPhisEntitlementKinds()[1]).toMatchObject({ addonId: "@acme/licenses", counted: true, description: "Per seat" });
    expect(listPhisEntitlementKinds()[0]).toMatchObject({ counted: false, description: null });
    expect((await capability().kinds()).length).toBe(2);
  });

  it("lists as listeners the enabled Add-ons that declare the event", () => {
    expect(listPhisEntitlementListeners()).toEqual(["@acme/licenses"]);
  });

  it("refuses an unverified hook on every call", async () => {
    const hook = capability({ unauthenticated: true });
    await expect(hook.kinds()).rejects.toThrow(/unverified hook/);
    await expect(hook.subject()).rejects.toThrow(/unverified hook/);
    await expect(hook.check({ kind: LICENSE })).rejects.toThrow(/unverified hook/);
    await expect(hook.list({})).rejects.toThrow(/unverified hook/);
    await expect(hook.grant({ subject: "sub_x", kind: LICENSE, reference: "o1" })).rejects.toThrow(/unverified hook/);
    await expect(hook.update({ kind: LICENSE, reference: "o1" })).rejects.toThrow(/unverified hook/);
    await expect(hook.revoke({ kind: LICENSE, reference: "o1" })).rejects.toThrow(/unverified hook/);
    expect(state.grant).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(state.readState).not.toHaveBeenCalled();
  });

  describe("grant", () => {
    it("is refused for an undeclared kind", async () => {
      await expect(capability().grant({ subject: "sub_x", kind: "@acme/licenses:nope", reference: "o1" })).rejects.toThrow(/no enabled Add-on declares/);
      await expect(capability().grant({ subject: "sub_x", kind: "@acme/off:hidden", reference: "o1" })).rejects.toThrow(/no enabled Add-on declares/);
      expect(state.grant).not.toHaveBeenCalled();
    });

    it("is refused for a source without leave and writes nothing", async () => {
      await expect(capability().grant({ subject: "sub_x", kind: LICENSE, reference: "o1" })).rejects.toThrow(/may not write/);
      expect(state.allowed).toHaveBeenCalledWith(7, LICENSE, SHOP);
      expect(state.grant).not.toHaveBeenCalled();
    });

    it("writes for a source the admin allowed, as that source, and asks for delivery", async () => {
      state.allowed.mockResolvedValue(true);
      await capability().grant({ subject: "sub_x", kind: LICENSE, reference: "o1", endsAt: "2030-01-01T00:00:00Z" });
      expect(state.grant).toHaveBeenCalledWith(expect.objectContaining({
        siteId: 7, subjectId: 5, kind: LICENSE, source: SHOP, reference: "o1",
        endsAt: "2030-01-01T00:00:00.000Z", quantity: null, listeners: ["@acme/licenses"],
      }));
      expect(state.deliver).toHaveBeenCalledWith(7);
    });

    it("needs no leave for the declaring Add-on", async () => {
      await capability({ addonId: "@acme/licenses" }).grant({ subject: "sub_x", kind: LICENSE, reference: "o1" });
      expect(state.allowed).not.toHaveBeenCalled();
      expect(state.grant).toHaveBeenCalledWith(expect.objectContaining({ source: "@acme/licenses" }));
    });

    it("is refused for a subject this Site does not have", async () => {
      state.findSubject.mockResolvedValue(null);
      await expect(capability({ addonId: "@acme/licenses" }).grant({ subject: "sub_other", kind: LICENSE, reference: "o1" })).rejects.toThrow(/subject this Site does not have/);
      expect(state.grant).not.toHaveBeenCalled();
    });

    it("refuses a quantity on an uncounted kind and a missing one on a counted kind", async () => {
      const owner = capability({ addonId: "@acme/licenses" });
      await expect(owner.grant({ subject: "sub_x", kind: LICENSE, reference: "o1", quantity: 2 })).rejects.toThrow(/does not count/);
      await expect(owner.grant({ subject: "sub_x", kind: SEATS, reference: "o1" })).rejects.toThrow(/counts/);
      await expect(owner.grant({ subject: "sub_x", kind: SEATS, reference: "o1", quantity: 0 })).rejects.toThrow(/counts/);
      await expect(owner.grant({ subject: "sub_x", kind: SEATS, reference: "o1", quantity: 1.5 })).rejects.toThrow(/counts/);
      expect(state.grant).not.toHaveBeenCalled();
      await owner.grant({ subject: "sub_x", kind: SEATS, reference: "o1", quantity: 3 });
      expect(state.grant).toHaveBeenCalledWith(expect.objectContaining({ quantity: 3 }));
    });

    it("refuses an end that is not after the start", async () => {
      const owner = capability({ addonId: "@acme/licenses" });
      await expect(owner.grant({ subject: "sub_x", kind: LICENSE, reference: "o1", startsAt: "2030-01-02T00:00:00Z", endsAt: "2030-01-01T00:00:00Z" })).rejects.toThrow(/after the start/);
    });
  });

  describe("revoke and update", () => {
    it("revoke needs no leave and reaches only the caller's own entries", async () => {
      state.update.mockResolvedValueOnce(null);
      expect(await capability().revoke({ kind: LICENSE, reference: "o1" })).toBeNull();
      expect(state.allowed).not.toHaveBeenCalled();
      expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ siteId: 7, source: SHOP, kind: LICENSE, reference: "o1", revoke: true }));
      expect(state.deliver).toHaveBeenCalledWith(7);
    });

    it("update is refused without leave", async () => {
      await expect(capability().update({ kind: LICENSE, reference: "o1", suspended: true })).rejects.toThrow(/may not write/);
      expect(state.update).not.toHaveBeenCalled();
    });

    it("update passes only what was stated", async () => {
      state.allowed.mockResolvedValue(true);
      await capability().update({ kind: LICENSE, reference: "o1", endsAt: null });
      const input = state.update.mock.calls[0]![0]!;
      expect(input).toMatchObject({ source: SHOP, endsAt: null });
      expect("quantity" in input).toBe(false);
      expect("suspended" in input).toBe(false);
    });
  });

  describe("check", () => {
    it("answers not entitled for an undeclared kind without reading entries", async () => {
      const answer = await capability().check({ kind: "@acme/licenses:nope" });
      expect(answer).toEqual({ kind: "@acme/licenses:nope", entitled: false, quantity: null, until: null });
      expect(state.readState).toHaveBeenCalledWith(expect.objectContaining({ subjectId: null }));
      expect(state.findSubject).not.toHaveBeenCalled();
      expect(state.ensureSubject).not.toHaveBeenCalled();
    });
  });
});
