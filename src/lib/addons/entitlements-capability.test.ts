import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhisEntitlementEntryName } from "@phis/contracts/entitlements";

vi.mock("server-only", () => ({}));

type Held = { id: string; flags: number; state: string };

const state = vi.hoisted(() => ({
  deliver: vi.fn(),
  installed: {} as Record<string, { flags: number; manifest: { eventHandlers?: { event: string }[] } }>,
  ensureSubject: vi.fn(async () => "sub_actor"),
  findSubject: vi.fn(async (): Promise<{ id: number; userId: number } | null> => ({ id: 5, userId: 9 })),
  grant: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ ...input, id: 1 })),
  update: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ ...input, id: 1 })),
  list: vi.fn(async (_input: Record<string, unknown>): Promise<unknown[]> => []),
  listNamed: vi.fn(async (input: { entries: unknown[] }): Promise<unknown[]> => input.entries.map(() => null)),
  readState: vi.fn(async (input: Record<string, unknown>) => ({ product: input.product, flags: input.subjectId !== null ? 1 : 0, quantity: null, until: null, via: [] })),
  readStates: vi.fn(async (input: { subjectId: number | null; products: string[] }) =>
    input.products.map((product) => ({ product, flags: input.subjectId !== null ? 1 : 0, quantity: null, until: null, via: [] }))),
  memberSubject: vi.fn(async (): Promise<string | null> => "sub_member"),
  redeliver: vi.fn(async (_input: Record<string, unknown>) => 3),
  siteAccess: vi.fn((_access: string) => false),
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
  listNamedEntitlements: (_pool: unknown, input: { entries: unknown[] }) => state.listNamed(input),
  readEntitlementState: (_pool: unknown, input: Record<string, unknown>) => state.readState(input),
  readEntitlementStates: (_pool: unknown, input: { subjectId: number | null; products: string[] }) => state.readStates(input),
  redeliverEntitlementChanged: (_pool: unknown, input: Record<string, unknown>) => state.redeliver(input),
  ensureMemberEntitlementSubject: (_pool: unknown, ...args: unknown[]) => (state.memberSubject as (...a: unknown[]) => Promise<string | null>)(...args),
  isSubscriptionOfAddon: (_pool: unknown, ...args: unknown[]) => (state.ownSubscription as (...a: unknown[]) => Promise<boolean>)(...args),
  isEntitlementSourceAllowed: (_pool: unknown, ...args: unknown[]) => (state.allowed as (...a: unknown[]) => Promise<boolean>)(...args),
}));
vi.mock("@/db/products.mts", () => ({ readProduct: (_pool: unknown, ...args: unknown[]) => (state.product as (...a: unknown[]) => Promise<Held | null>)(...args) }));

import { buildPhisAddonEntitlementsCapability, listPhisEntitlementListeners } from "./entitlements-capability.ts";

const LICENSE = "@acme/licenses:pro";
const SEATS = "@acme/licenses:seats";
const SHOP = "@acme/shop";
const heldProducts: Record<string, Held> = {
  [LICENSE]: { id: LICENSE, flags: 0, state: "active" },
  [SEATS]: { id: SEATS, flags: 1, state: "active" },
  "@acme/licenses:gratis": { id: "@acme/licenses:gratis", flags: 4, state: "active" },
};

function capability(overrides: Partial<Parameters<typeof buildPhisAddonEntitlementsCapability>[0]> = {}) {
  return buildPhisAddonEntitlementsCapability({
    addonId: SHOP, siteId: 7, actorUserId: 9, unauthenticated: false, readSiteAccess: async () => state.siteAccess, ...overrides,
  });
}

describe("entitlements capability", () => {
  beforeEach(() => {
    state.installed = {
      "@acme/licenses": { flags: 1, manifest: { eventHandlers: [{ event: "entitlement.changed" }] } },
      "@acme/shop": { flags: 1, manifest: {} },
      "@acme/off": { flags: 0, manifest: { eventHandlers: [{ event: "entitlement.changed" }] } },
      "@acme/showcase": { flags: 1, manifest: { eventHandlers: [{ event: "product.changed" }] } },
    };
    state.allowed.mockResolvedValue(false);
    state.ownSubscription.mockResolvedValue(true);
    state.findSubject.mockResolvedValue({ id: 5, userId: 9 });
    state.siteAccess.mockReturnValue(false);
    state.memberSubject.mockResolvedValue("sub_member");
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
    await expect(hook.checkMany({ products: [LICENSE] })).rejects.toThrow(/unverified hook/);
    await expect(hook.subjectForUser({ userId: 12 })).rejects.toThrow(/unverified hook/);
    await expect(hook.list({})).rejects.toThrow(/unverified hook/);
    await expect(hook.grant({ subject: "sub_x", product: LICENSE, reference: "o1" })).rejects.toThrow(/unverified hook/);
    await expect(hook.update({ product: LICENSE, reference: "o1" })).rejects.toThrow(/unverified hook/);
    await expect(hook.revoke({ product: LICENSE, reference: "o1" })).rejects.toThrow(/unverified hook/);
    expect(state.grant).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(state.readState).not.toHaveBeenCalled();
  });

  describe("checkMany", () => {
    it("answers every product asked for in one read, in the order asked, for the subject named or the actor", async () => {
      const answers = await capability().checkMany({ products: [SEATS, LICENSE, SEATS] });
      expect(answers.map((answer) => answer.product)).toEqual([SEATS, LICENSE, SEATS]);
      expect(state.readStates).toHaveBeenCalledTimes(1);
      expect(state.readStates).toHaveBeenLastCalledWith(expect.objectContaining({ siteId: 7, subjectId: 5, products: [SEATS, LICENSE, SEATS] }));
      await capability().checkMany({ products: [LICENSE], subject: "sub_x" });
      expect(state.findSubject).toHaveBeenLastCalledWith(7, "sub_x");
      // Nobody acting and nobody named: every answer is no, from the same read.
      await capability({ actorUserId: null }).checkMany({ products: [LICENSE] });
      expect(state.readStates).toHaveBeenLastCalledWith(expect.objectContaining({ subjectId: null }));
    });

    it("answers an empty list with nothing, and refuses more than 100 products or one that is no product id", async () => {
      expect(await capability().checkMany({ products: [] })).toEqual([]);
      const many = Array.from({ length: 101 }, (_, index) => `@acme/licenses:p${index}` as const);
      await expect(capability().checkMany({ products: many })).rejects.toThrow(/at most 100/);
      await expect(capability().checkMany({ products: [LICENSE, "nonsense" as never] })).rejects.toThrow(/not a product id/);
      await expect(capability().checkMany({ products: "nonsense" as never })).rejects.toThrow(/at most 100/);
      expect(state.readStates).not.toHaveBeenCalled();
      await capability().checkMany({ products: many.slice(0, 100) });
      expect(state.readStates).toHaveBeenCalledTimes(1);
    });
  });

  describe("subjectForUser", () => {
    it("hands staff holding accounting or support a member's subject, and null for a user who is no member", async () => {
      state.siteAccess.mockImplementation((access) => access === "accounting");
      expect(await capability().subjectForUser({ userId: 12 })).toBe("sub_member");
      expect(state.memberSubject).toHaveBeenLastCalledWith(7, 12);
      state.siteAccess.mockImplementation((access) => access === "support");
      state.memberSubject.mockResolvedValueOnce(null);
      expect(await capability().subjectForUser({ userId: 13 })).toBeNull();
    });

    it("is refused without accounting or support, with nobody acting, and for a userId that is no id", async () => {
      state.siteAccess.mockImplementation((access) => access === "content-editing" || access === "site-media");
      await expect(capability().subjectForUser({ userId: 12 })).rejects.toThrow(/accounting or support/);
      state.siteAccess.mockReturnValue(true);
      await expect(capability({ actorUserId: null }).subjectForUser({ userId: 12 })).rejects.toThrow(/accounting or support/);
      for (const userId of [0, -1, 1.5, "12" as never]) {
        await expect(capability().subjectForUser({ userId })).rejects.toThrow(/positive whole number/);
      }
      expect(state.memberSubject).not.toHaveBeenCalled();
    });
  });

  describe("redeliver", () => {
    const LISTENING = "@acme/licenses";

    it("queues the calling Add-on's own redelivery for staff holding accounting, and schedules the delivery", async () => {
      state.siteAccess.mockImplementation((access) => access === "accounting");
      expect(await capability({ addonId: LISTENING }).redeliver({ product: LICENSE })).toEqual({ queued: 3 });
      expect(state.redeliver).toHaveBeenLastCalledWith({ siteId: 7, addonId: LISTENING, product: LICENSE });
      expect(state.deliver).toHaveBeenLastCalledWith(7);
      // Nothing queued, nothing to deliver.
      state.deliver.mockClear();
      state.redeliver.mockResolvedValueOnce(0);
      expect(await capability({ addonId: LISTENING }).redeliver({ product: LICENSE })).toEqual({ queued: 0 });
      expect(state.deliver).not.toHaveBeenCalled();
    });

    it("is refused without accounting (support is not enough), with nobody acting, from an unverified hook, without a handler, and for no product id", async () => {
      state.siteAccess.mockImplementation((access) => access === "support");
      await expect(capability({ addonId: LISTENING }).redeliver({ product: LICENSE })).rejects.toThrow(/Site access accounting/);
      state.siteAccess.mockReturnValue(true);
      await expect(capability({ addonId: LISTENING, actorUserId: null }).redeliver({ product: LICENSE })).rejects.toThrow(/Site access accounting/);
      await expect(capability({ addonId: LISTENING, unauthenticated: true }).redeliver({ product: LICENSE })).rejects.toThrow(/unverified hook/);
      // The shop declares no handler, and a switched-off Add-on is no listener.
      await expect(capability().redeliver({ product: LICENSE })).rejects.toThrow(/handler for entitlement.changed/);
      await expect(capability({ addonId: "@acme/off" }).redeliver({ product: LICENSE })).rejects.toThrow(/handler for entitlement.changed/);
      await expect(capability({ addonId: LISTENING }).redeliver({ product: "licenses" as never })).rejects.toThrow(/not a product id/);
      expect(state.redeliver).not.toHaveBeenCalled();
    });
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
      state.product.mockResolvedValueOnce({ id: "@acme/licenses:bundle", flags: 0, state: "active", parts: [LICENSE, SEATS] } as never);
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
      await expect(capability().update({ product: LICENSE, reference: "o1", setFlags: 2 })).rejects.toThrow(/may not write/);
      expect(state.update).not.toHaveBeenCalled();
    });

    it("update goes through whatever the product's state, and passes only what was stated", async () => {
      state.allowed.mockResolvedValue(true);
      state.product.mockResolvedValueOnce({ id: LICENSE, flags: 0, state: "withdrawn" });
      await capability().update({ product: LICENSE, reference: "o1", endsAt: null });
      const input = state.update.mock.calls[0]![0]!;
      expect(input).toMatchObject({ source: SHOP, endsAt: null });
      expect("quantity" in input).toBe(false);
      expect(input).toMatchObject({ setFlags: 0, clearFlags: 0 });
      expect("unbind" in input).toBe(false);
    });

    it("update of an entry whose product is gone works for the allowed source, except a quantity", async () => {
      state.allowed.mockResolvedValue(true);
      await capability().update({ product: "@acme/licenses:gone", reference: "o1", setFlags: 2 });
      expect(state.update).toHaveBeenCalledTimes(1);
      await expect(capability().update({ product: "@acme/licenses:gone", reference: "o1", quantity: 2 })).rejects.toThrow(/no longer has/);
    });
  });

  describe("update's flags and unbinding", () => {
    beforeEach(() => { state.allowed.mockResolvedValue(true); state.update.mockClear(); });

    it("passes Suspended to set or clear, and refuses any other bit or both at once", async () => {
      await capability().update({ product: LICENSE, reference: "o1", setFlags: 2 });
      expect(state.update).toHaveBeenLastCalledWith(expect.objectContaining({ setFlags: 2, clearFlags: 0 }));
      await capability().update({ product: LICENSE, reference: "o1", clearFlags: 2 });
      expect(state.update).toHaveBeenLastCalledWith(expect.objectContaining({ setFlags: 0, clearFlags: 2 }));
      for (const bad of [{ setFlags: 1 }, { clearFlags: 1 }, { setFlags: 2, clearFlags: 2 }, { setFlags: true }]) {
        await expect(capability().update({ product: LICENSE, reference: "o1", ...bad } as never)).rejects.toThrow();
      }
      expect(state.update).toHaveBeenCalledTimes(2);
    });

    it("unbinds with subscriptionId null, and refuses binding onto a subscription", async () => {
      await capability().update({ product: LICENSE, reference: "S1", subscriptionId: null });
      expect(state.update).toHaveBeenLastCalledWith(expect.objectContaining({ unbind: true }));
      await capability().update({ product: LICENSE, reference: "S1", subscriptionId: null, endsAt: "2030-01-01T00:00:00Z" });
      expect(state.update).toHaveBeenLastCalledWith(expect.objectContaining({ unbind: true, endsAt: "2030-01-01T00:00:00.000Z" }));
      await expect(capability().update({ product: LICENSE, reference: "S1", subscriptionId: "sub-1" as never })).rejects.toThrow(/only taken off/);
    });
  });

  describe("listNamed", () => {
    beforeEach(() => { state.listNamed.mockClear(); state.ensureSubject.mockClear(); });

    it("reads every name in one call, the acting person's subject where a name gives none", async () => {
      const entries = [{ source: SHOP, reference: "S1", product: LICENSE }, { source: SHOP, reference: "S2", product: SEATS, subject: "sub_other" }] as PhisEntitlementEntryName[];
      expect(await capability().listNamed({ entries })).toEqual([null, null]);
      expect(state.listNamed).toHaveBeenCalledOnce();
      expect(state.listNamed).toHaveBeenCalledWith({ siteId: 7, entries: [{ ...entries[0], subject: undefined }, entries[1]], fallbackSubject: "sub_actor" });
    });

    it("asks no subject when every name gives one, and nobody's without an acting person", async () => {
      await capability().listNamed({ entries: [{ source: SHOP, reference: "S1", product: LICENSE, subject: "sub_x" }] });
      expect(state.ensureSubject).not.toHaveBeenCalled();
      await capability({ actorUserId: null }).listNamed({ entries: [{ source: SHOP, reference: "S1", product: LICENSE }] });
      expect(state.listNamed).toHaveBeenLastCalledWith(expect.objectContaining({ fallbackSubject: null }));
    });

    it("answers none for none and refuses more than 100 names or one that is not a name", async () => {
      expect(await capability().listNamed({ entries: [] })).toEqual([]);
      expect(state.listNamed).not.toHaveBeenCalled();
      const many = Array.from({ length: 101 }, (_, i) => ({ source: SHOP, reference: `S${i}`, product: LICENSE })) as PhisEntitlementEntryName[];
      await expect(capability().listNamed({ entries: many })).rejects.toThrow(/at most 100/);
      await expect(capability().listNamed({ entries: [{ source: SHOP, reference: "S1", product: "nope" as never }] })).rejects.toThrow(/not a product id/);
      await expect(capability().listNamed({ entries: [{ source: 5, reference: "S1", product: LICENSE } as never] })).rejects.toThrow(/not \{ source/);
      await expect(capability({ unauthenticated: true }).listNamed({ entries: [] })).rejects.toThrow(/unverified hook/);
    });
  });

  describe("check", () => {
    it("answers not entitled for something that is no product id without reading entries", async () => {
      const answer = await capability().check({ product: "nonsense" as never });
      expect(answer).toEqual({ product: "nonsense", flags: 0, quantity: null, until: null, via: [] });
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
    it("reads ResolveBundles from flags, and false where they are left out", async () => {
      await capability().list({ product: LICENSE, flags: 1 });
      expect(state.list).toHaveBeenLastCalledWith({ siteId: 7, subjectId: 5, product: LICENSE, resolveBundles: true });
      await capability().list({ product: LICENSE });
      expect(state.list).toHaveBeenLastCalledWith({ siteId: 7, subjectId: 5, product: LICENSE, resolveBundles: false });
      await capability().list({ product: LICENSE, flags: 0 });
      expect(state.list).toHaveBeenLastCalledWith({ siteId: 7, subjectId: 5, product: LICENSE, resolveBundles: false });
    });

    it("refuses flags with an unknown bit or not a number, before reading anything", async () => {
      state.list.mockClear();
      state.findSubject.mockClear();
      for (const value of [true, "1", 2, -1, 1.5, null]) {
        await expect(capability().list({ product: LICENSE, flags: value as never })).rejects.toThrow(/not accepted/);
      }
      expect(state.list).not.toHaveBeenCalled();
      expect(state.findSubject).not.toHaveBeenCalled();
    });

    it("lists several subjects in one read, each once, without resolving them one by one", async () => {
      state.list.mockClear();
      state.findSubject.mockClear();
      await capability().list({ subjects: ["sub_a", "sub_b", "sub_a"], product: LICENSE });
      expect(state.list).toHaveBeenCalledOnce();
      expect(state.list).toHaveBeenLastCalledWith({ siteId: 7, subjectReferences: ["sub_a", "sub_b"], product: LICENSE, resolveBundles: false });
      expect(state.findSubject).not.toHaveBeenCalled();
      // Nobody asked about: nothing read.
      state.list.mockClear();
      expect(await capability().list({ subjects: [] })).toEqual([]);
      expect(state.list).not.toHaveBeenCalled();
    });

    it("refuses subjects beside subject, more than 100 of them, or one that is not a reference", async () => {
      state.list.mockClear();
      await expect(capability().list({ subject: "sub_a", subjects: ["sub_b"] })).rejects.toThrow(/both subject and subjects/);
      const many = Array.from({ length: 101 }, (_, index) => `sub_${index}`);
      await expect(capability().list({ subjects: many })).rejects.toThrow(/at most 100 subjects/);
      await expect(capability().list({ subjects: ["sub_a", 5 as never] })).rejects.toThrow(/at most 100 subjects/);
      await expect(capability().list({ subjects: "sub_a" as never })).rejects.toThrow(/at most 100 subjects/);
      expect(state.list).not.toHaveBeenCalled();
      await capability().list({ subjects: many.slice(0, 100) });
      expect(state.list).toHaveBeenCalledOnce();
    });

    it("refuses a listing longer than 500 entries rather than answering part of it", async () => {
      const entries = (count: number) => Array.from({ length: count }, (_, id) => ({ id }));
      state.list.mockResolvedValueOnce(entries(500));
      expect(await capability().list({ subjects: ["sub_a"] })).toHaveLength(500);
      state.list.mockResolvedValueOnce(entries(501));
      await expect(capability().list({ subjects: ["sub_a", "sub_b"] })).rejects.toThrow(/more than 500 entries; ask for fewer subjects or one product/);
      state.list.mockResolvedValueOnce(entries(501));
      await expect(capability().list({})).rejects.toThrow(/more than 500 entries/);
    });

    it("keeps subjects from an unverified hook", async () => {
      await expect(capability({ unauthenticated: true }).list({ subjects: ["sub_a"] })).rejects.toThrow(/unverified hook/);
    });
  });
});
