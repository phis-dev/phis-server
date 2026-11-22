import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Held = { id: string; counted: boolean; free: boolean; state: string };

const state = vi.hoisted(() => ({
  deliver: vi.fn(),
  installed: {} as Record<string, { enabled: boolean; manifest: { eventHandlers?: { event: string }[] } }>,
  ensureSubject: vi.fn(async () => "sub_actor"),
  findSubject: vi.fn(async (): Promise<{ id: number; userId: number } | null> => ({ id: 5, userId: 9 })),
  grant: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ ...input, id: 1 })),
  update: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ ...input, id: 1 })),
  list: vi.fn(async (_input: Record<string, unknown>): Promise<unknown[]> => []),
  readState: vi.fn(async (input: Record<string, unknown>) => ({ product: input.product, entitled: input.subjectId !== null, quantity: null, until: null, via: [] })),
  allowed: vi.fn(async () => false),
  ownSubscription: vi.fn(async () => true),
  product: vi.fn(async (): Promise<Held | null> => null),
}));
vi.mock("./installed.ts", () => ({ getPhisAddonInstalledManifest: () => state.installed }));
vi.mock("./event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: (...args: unknown[]) => state.deliver(...args) }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/entitlements.mts", () => ({
  ensureEntitlementSubject: (_pool: unknown, ...args: unknown[]) => state.ensureSubject(...(args as [])),
  findEntitlementSubject: (_pool: unknown, ...args: unknown[]) => state.findSubject(...(args as [])),
  grantEntitlement: (_pool: unknown, input: Record<string, unknown>) => state.grant(input),
  updateEntitlement: (_pool: unknown, input: Record<string, unknown>) => state.update(input),
  listEntitlements: (_pool: unknown, input: Record<string, unknown>) => state.list(input),
  readEntitlementState: (_pool: unknown, input: Record<string, unknown>) => state.readState(input),
  isSubscriptionOfAddon: (_pool: unknown, ...args: unknown[]) => (state.ownSubscription as (...a: unknown[]) => Promise<boolean>)(...args),
  isEntitlementSourceAllowed: (_pool: unknown, ...args: unknown[]) => (state.allowed as (...a: unknown[]) => Promise<boolean>)(...args),
}));
vi.mock("@/db/products.mts", () => ({ readProduct: (_pool: unknown, ...args: unknown[]) => (state.product as (...a: unknown[]) => Promise<Held | null>)(...args) }));

import { buildPhisAddonEntitlementsCapability, listPhisEntitlementListeners } from "./entitlements-capability.ts";

const LICENSE = "@acme/licenses:pro";
const SEATS = "@acme/licenses:seats";
const SHOP = "@acme/shop";
const heldProducts: Record<string, Held> = {
  [LICENSE]: { id: LICENSE, counted: false, free: false, state: "active" },
  [SEATS]: { id: SEATS, counted: true, free: false, state: "active" },
  "@acme/licenses:gratis": { id: "@acme/licenses:gratis", counted: false, free: true, state: "active" },
};

function capability(overrides: Partial<Parameters<typeof buildPhisAddonEntitlementsCapability>[0]> = {}) {
  return buildPhisAddonEntitlementsCapability({ addonId: SHOP, siteId: 7, actorUserId: 9, unauthenticated: false, ...overrides });
}

describe("entitlements capability", () => {
  beforeEach(() => {
    state.installed = {
      "@acme/licenses": { enabled: true, manifest: { eventHandlers: [{ event: "entitlement.changed" }] } },
      "@acme/shop": { enabled: true, manifest: {} },
      "@acme/off": { enabled: false, manifest: { eventHandlers: [{ event: "entitlement.changed" }] } },
      "@acme/showcase": { enabled: true, manifest: { eventHandlers: [{ event: "product.changed" }] } },
    };
    state.allowed.mockResolvedValue(false);
    state.ownSubscription.mockResolvedValue(true);
    state.findSubject.mockResolvedValue({ id: 5, userId: 9 });
    state.product.mockImplementation(async (...args: unknown[]) => heldProducts[args[1] as string] ?? null);
  });

  it("has no kinds any more: the catalogue is the product directory", () => {
    expect("kinds" in capability()).toBe(false);
  });

  it("lists as listeners the enabled Add-ons that declare the event", () => {
    expect(listPhisEntitlementListeners()).toEqual(["@acme/licenses"]);
  });

  it("refuses an unverified hook on every call", async () => {
    const hook = capability({ unauthenticated: true });
    await expect(hook.subject()).rejects.toThrow(/unverified hook/);
    await expect(hook.check({ product: LICENSE })).rejects.toThrow(/unverified hook/);
    await expect(hook.list({})).rejects.toThrow(/unverified hook/);
    await expect(hook.grant({ subject: "sub_x", product: LICENSE, reference: "o1" })).rejects.toThrow(/unverified hook/);
    await expect(hook.update({ product: LICENSE, reference: "o1" })).rejects.toThrow(/unverified hook/);
    await expect(hook.revoke({ product: LICENSE, reference: "o1" })).rejects.toThrow(/unverified hook/);
    expect(state.grant).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(state.readState).not.toHaveBeenCalled();
  });

  describe("grant", () => {
    it("is refused for a product this Site does not have", async () => {
      await expect(capability().grant({ subject: "sub_x", product: "@acme/licenses:nope", reference: "o1" })).rejects.toThrow(/does not have/);
      await expect(capability().grant({ subject: "sub_x", product: "licenses" as never, reference: "o1" })).rejects.toThrow(/not a product id/);
      expect(state.grant).not.toHaveBeenCalled();
    });

    it("is refused for a source the operator did not allow and writes nothing", async () => {
      await expect(capability().grant({ subject: "sub_x", product: LICENSE, reference: "o1" })).rejects.toThrow(/may not write/);
      // The operator's allowance is asked for the product's supplier.
      expect(state.allowed).toHaveBeenCalledWith(7, "@acme/licenses", SHOP);
      expect(state.grant).not.toHaveBeenCalled();
    });

    it("writes for a source the operator allowed, as that source, and asks for delivery", async () => {
      state.allowed.mockResolvedValue(true);
      await capability().grant({ subject: "sub_x", product: LICENSE, reference: "o1", endsAt: "2030-01-01T00:00:00Z" });
      expect(state.grant).toHaveBeenCalledWith(expect.objectContaining({
        siteId: 7, subjectId: 5, product: LICENSE, source: SHOP, reference: "o1",
        endsAt: "2030-01-01T00:00:00.000Z", quantity: null, counted: false, listeners: ["@acme/licenses"],
      }));
      expect(state.deliver).toHaveBeenCalledWith(7);
    });

    it("lets a supplier write its own free product without leave, and no other of its products", async () => {
      const supplier = capability({ addonId: "@acme/licenses" });
      await supplier.grant({ subject: "sub_x", product: "@acme/licenses:gratis", reference: "o1" });
      expect(state.allowed).not.toHaveBeenCalled();
      expect(state.grant).toHaveBeenCalledWith(expect.objectContaining({ source: "@acme/licenses" }));
      await expect(supplier.grant({ subject: "sub_x", product: LICENSE, reference: "o2" })).rejects.toThrow(/may not write/);
    });

    it("is refused for a product that is not active, which the write itself judges", async () => {
      state.allowed.mockResolvedValue(true);
      state.grant.mockResolvedValueOnce(null);
      await expect(capability().grant({ subject: "sub_x", product: LICENSE, reference: "o1" })).rejects.toThrow(/not active/);
      expect(state.deliver).not.toHaveBeenCalled();
    });

    it("is refused for a subject this Site does not have", async () => {
      state.allowed.mockResolvedValue(true);
      state.findSubject.mockResolvedValue(null);
      await expect(capability().grant({ subject: "sub_other", product: LICENSE, reference: "o1" })).rejects.toThrow(/subject this Site does not have/);
      expect(state.grant).not.toHaveBeenCalled();
    });

    it("takes whether to count from the product", async () => {
      state.allowed.mockResolvedValue(true);
      const source = capability();
      await expect(source.grant({ subject: "sub_x", product: LICENSE, reference: "o1", quantity: 2 })).rejects.toThrow(/does not count/);
      await expect(source.grant({ subject: "sub_x", product: SEATS, reference: "o1" })).rejects.toThrow(/counts/);
      await expect(source.grant({ subject: "sub_x", product: SEATS, reference: "o1", quantity: 0 })).rejects.toThrow(/counts/);
      await expect(source.grant({ subject: "sub_x", product: SEATS, reference: "o1", quantity: 1.5 })).rejects.toThrow(/counts/);
      expect(state.grant).not.toHaveBeenCalled();
      await source.grant({ subject: "sub_x", product: SEATS, reference: "o1", quantity: 3 });
      expect(state.grant).toHaveBeenCalledWith(expect.objectContaining({ quantity: 3, counted: true }));
    });

    it("writes one entry for a bundle and resolves nothing", async () => {
      state.allowed.mockResolvedValue(true);
      state.product.mockResolvedValueOnce({ id: "@acme/licenses:bundle", counted: false, free: false, state: "active", parts: [LICENSE, SEATS] } as never);
      await capability().grant({ subject: "sub_x", product: "@acme/licenses:bundle", reference: "o1" });
      expect(state.grant).toHaveBeenCalledTimes(1);
    });

    it("binds an entry to the caller's own subscription and passes no end", async () => {
      state.allowed.mockResolvedValue(true);
      await capability().grant({ subject: "sub_x", product: LICENSE, reference: "o1", subscriptionId: "5f0c0000-0000-4000-8000-000000000001" });
      expect(state.ownSubscription).toHaveBeenCalledWith(7, "5f0c0000-0000-4000-8000-000000000001", SHOP);
      expect(state.grant).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: "5f0c0000-0000-4000-8000-000000000001", endsAt: null }));
      // Without a subscription nothing is bound.
      await capability().grant({ subject: "sub_x", product: LICENSE, reference: "o2" });
      expect(state.grant).toHaveBeenLastCalledWith(expect.objectContaining({ subscriptionId: null }));
    });

    it("refuses a bound entry that also states an end, and a subscription the caller did not create", async () => {
      state.allowed.mockResolvedValue(true);
      await expect(capability().grant({ subject: "sub_x", product: LICENSE, reference: "o1", subscriptionId: "s1", endsAt: "2030-01-01T00:00:00Z" })).rejects.toThrow(/no written end/);
      state.ownSubscription.mockResolvedValue(false);
      await expect(capability().grant({ subject: "sub_x", product: LICENSE, reference: "o1", subscriptionId: "s1" })).rejects.toThrow(/did not create/);
      await expect(capability().grant({ subject: "sub_x", product: LICENSE, reference: "o1", subscriptionId: 5 as never })).rejects.toThrow(/did not create/);
      expect(state.grant).not.toHaveBeenCalled();
    });

    it("refuses an end that is not after the start", async () => {
      state.allowed.mockResolvedValue(true);
      await expect(capability().grant({ subject: "sub_x", product: LICENSE, reference: "o1", startsAt: "2030-01-02T00:00:00Z", endsAt: "2030-01-01T00:00:00Z" })).rejects.toThrow(/after the start/);
    });
  });

  describe("revoke and update", () => {
    it("revoke needs no leave and no product, and reaches only the caller's own entries", async () => {
      state.update.mockResolvedValueOnce(null);
      expect(await capability().revoke({ product: "@acme/licenses:gone", reference: "o1" })).toBeNull();
      expect(state.allowed).not.toHaveBeenCalled();
      expect(state.product).not.toHaveBeenCalled();
      expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ siteId: 7, source: SHOP, product: "@acme/licenses:gone", reference: "o1", revoke: true }));
      expect(state.deliver).toHaveBeenCalledWith(7);
    });

    it("update is refused without leave", async () => {
      await expect(capability().update({ product: LICENSE, reference: "o1", suspended: true })).rejects.toThrow(/may not write/);
      expect(state.update).not.toHaveBeenCalled();
    });

    it("update goes through whatever the product's state, and passes only what was stated", async () => {
      state.allowed.mockResolvedValue(true);
      state.product.mockResolvedValueOnce({ id: LICENSE, counted: false, free: false, state: "withdrawn" });
      await capability().update({ product: LICENSE, reference: "o1", endsAt: null });
      const input = state.update.mock.calls[0]![0]!;
      expect(input).toMatchObject({ source: SHOP, endsAt: null });
      expect("quantity" in input).toBe(false);
      expect("suspended" in input).toBe(false);
    });

    it("update of an entry whose product is gone works for the allowed source, except a quantity", async () => {
      state.allowed.mockResolvedValue(true);
      await capability().update({ product: "@acme/licenses:gone", reference: "o1", suspended: true });
      expect(state.update).toHaveBeenCalledTimes(1);
      await expect(capability().update({ product: "@acme/licenses:gone", reference: "o1", quantity: 2 })).rejects.toThrow(/no longer has/);
    });
  });

  describe("check", () => {
    it("answers not entitled for something that is no product id without reading entries", async () => {
      const answer = await capability().check({ product: "nonsense" as never });
      expect(answer).toEqual({ product: "nonsense", entitled: false, quantity: null, until: null, via: [] });
      expect(state.readState).toHaveBeenCalledWith(expect.objectContaining({ subjectId: null }));
      expect(state.findSubject).not.toHaveBeenCalled();
      expect(state.ensureSubject).not.toHaveBeenCalled();
    });

    it("asks the entries about a product id and leaves counting to them", async () => {
      await capability().check({ product: LICENSE });
      expect(state.readState).toHaveBeenCalledWith({ siteId: 7, subjectId: 5, product: LICENSE });
    });
  });

  describe("list", () => {
    it("passes resolveBundles through, and false where it is left out", async () => {
      await capability().list({ product: LICENSE, resolveBundles: true });
      expect(state.list).toHaveBeenLastCalledWith({ siteId: 7, subjectId: 5, product: LICENSE, resolveBundles: true });
      await capability().list({ product: LICENSE });
      expect(state.list).toHaveBeenLastCalledWith({ siteId: 7, subjectId: 5, product: LICENSE, resolveBundles: false });
      await capability().list({ product: LICENSE, resolveBundles: false });
      expect(state.list).toHaveBeenLastCalledWith({ siteId: 7, subjectId: 5, product: LICENSE, resolveBundles: false });
    });

    it("refuses a resolveBundles that is not a boolean, before reading anything", async () => {
      state.list.mockClear();
      state.findSubject.mockClear();
      for (const value of ["true", 1, null, {}]) {
        await expect(capability().list({ product: LICENSE, resolveBundles: value as never })).rejects.toThrow(/resolveBundles that is not a boolean/);
      }
      expect(state.list).not.toHaveBeenCalled();
      expect(state.findSubject).not.toHaveBeenCalled();
    });
  });
});
