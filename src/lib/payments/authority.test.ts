import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import type { PhisPaymentAuthority, PhisPaymentProfile, PhisStoredPayment } from "./types.ts";
import { buildPhisPaymentsCapability } from "./runtime.ts";
vi.mock("../addons/event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: vi.fn() }));

const dependencies = vi.hoisted(() => ({ profile: null as unknown, payment: null as unknown, granted: vi.fn(async () => [] as unknown[]),
  role: false, admin: false, billing: false, transaction: vi.fn(async () => { throw new Error("authorized-reservation-boundary"); }) }));
vi.mock("../db", () => ({ getPool: () => ({}) }));
vi.mock("../../db/payments.mts", () => ({ listPhisPaymentProfilesGrantedTo: (...args: unknown[]) => dependencies.granted(...args as []), readPhisPayment: async () => dependencies.payment, readPhisPaymentProfile: async () => dependencies.profile,
  readPhisPaymentOperation: async () => ({ record: { id: "operation-1", paymentId: "payment-1" } }), readPhisPaymentRefund: async () => ({ record: { id: "refund-1", paymentId: "payment-1" } }),
  readPhisPaymentStoredMethod: async () => ({ record: { id: "method-1", profileKey: "sandbox" } }) }));
vi.mock("../../db/payment-subscriptions.mts", () => ({ readPhisPaymentSubscription: async () => ({ record: { id: "subscription-1", profileKey: "sandbox" } }) }));
vi.mock("../db-transaction.ts", () => ({ withPoolTransaction: (...args: unknown[]) => dependencies.transaction(...args as []) }));
vi.mock("../addons/site-access.ts", () => ({ holdsPhisSiteAccess: async () => dependencies.admin, holdsPhisBillingRole: async () => dependencies.billing }));
vi.mock("../addons/roles-capability.ts", () => ({ buildPhisAddonRolesCapability: () => ({ has: async (role: string) => dependencies.role && role === "merchant" }) }));

describe("Core-bound Payment merchant authority", () => {
  const manifest = { addonId: "@test/shop", roles: [{ name: "merchant" }], jobs: [{ id: "settle" }], eventHandlers: [{ event: "payment.changed" }] } as PhisAddonManifestV1;
  beforeEach(() => {
    dependencies.admin = false; dependencies.role = false; dependencies.transaction.mockClear();
    const policy = { roles: ["merchant"], jobs: ["settle"], events: ["payment.changed"] };
    dependencies.profile = { key: "sandbox", siteId: 1, providerKey: "@test/provider/main", providerAddonId: "@test/provider", mode: "test",
      credentialReferences: {}, merchantIdentity: "acct_test", revision: 1, enabled: true, retired: false, probedAt: "2026-10-04T00:00:00.000Z", features: {}, grants: [{ consumerAddonId: manifest.addonId, operations: ["read", "refund"], merchantActions: { capture: policy, cancel: policy, refund: policy } }] } as PhisPaymentProfile;
    dependencies.payment = { record: { id: "payment-1", profileKey: "sandbox", status: "captured" }, consumerAddonId: manifest.addonId, siteId: 1 } as PhisStoredPayment;
  });
  function capability(authority: PhisPaymentAuthority) {
    return buildPhisPaymentsCapability({ scope: { siteId: 1, siteKey: "demo", consumerAddonId: manifest.addonId }, manifest, authority, signal: new AbortController().signal });
  }
  async function tryRefund(authority: PhisPaymentAuthority) {
    return capability(authority).refund({ paymentId: "payment-1", idempotencyKey: "refund-1", minor: "500", reason: "Return" });
  }
  it.each([
    { kind: "request", operator: false, actorUserId: null },
    { kind: "request", operator: false, actorUserId: 7 },
    { kind: "job", id: "not-the-declared-job" },
    { kind: "event", id: "thread.status.changed" },
    { kind: "hook" },
  ] as PhisPaymentAuthority[])("refuses an unapproved actor/context before reserving: %j", async authority => {
    await expect(tryRefund(authority)).rejects.toMatchObject({ code: "forbidden" });
    expect(dependencies.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { kind: "request", operator: true, actorUserId: null },
    { kind: "job", id: "settle" },
    { kind: "event", id: "payment.changed" },
  ] as PhisPaymentAuthority[])("admits an explicitly authorized Core context: %j", async authority => {
    await expect(tryRefund(authority)).rejects.toThrow("authorized-reservation-boundary");
    expect(dependencies.transaction).toHaveBeenCalledOnce();
  });
  it("uses existing Site Admin or consumer role authority", async () => {
    dependencies.admin = true;
    await expect(tryRefund({ kind: "request", operator: false, actorUserId: 7 })).rejects.toThrow("authorized-reservation-boundary");
    dependencies.admin = false; dependencies.role = true;
    await expect(tryRefund({ kind: "request", operator: false, actorUserId: 7 })).rejects.toThrow("authorized-reservation-boundary");
  });
  it("requires a grant even for the operator", async () => {
    (dependencies.profile as PhisPaymentProfile).grants = [];
    await expect(tryRefund({ kind: "request", operator: true, actorUserId: null })).rejects.toMatchObject({ code: "not_found" });
    expect(dependencies.transaction).not.toHaveBeenCalled();
  });
});

describe("a profile's recorded features, the two operations a hook may call", () => {
  const manifest = { addonId: "@test/shop", roles: [{ name: "merchant" }], jobs: [], eventHandlers: [{ event: "payment.changed" }] } as unknown as PhisAddonManifestV1;
  const policy = { roles: ["merchant"], jobs: [], events: [] };
  const currency = { amounts: "single", conversion: "none", conversionCurrencies: [], conversionCost: null, settlementCurrencies: ["CHF"], flags: 0 };
  const every = { units: ["day", "week", "month", "year"], maxDays: null };
  const recording = { currency: "CHF", probedAt: "2026-11-21T10:00:00.000Z", policies: [
    { basis: "final", tax: "none", captureModes: ["automatic", "manual"], collection: { automatic: { units: ["month"], maxDays: 31 }, paymentRequest: every, providerManaged: null },
      currency, documents: null, merchantOfRecord: null },
    { basis: "final", tax: "merchant-of-record", captureModes: ["automatic"], collection: { automatic: null, paymentRequest: { units: ["year"], maxDays: 366 }, providerManaged: null },
      currency: { ...currency, conversion: "mandatory", conversionCurrencies: ["EUR"], conversionCost: "customer" },
      documents: { kinds: [{ kind: "invoice", flags: 3 }], issuer: { kind: "provider", name: "Sold through Link, LLC", taxId: null } },
      merchantOfRecord: { countries: ["DE"], taxCategories: ["digital-goods"], businessTaxIds: ["charge"] } },
  ] };
  beforeEach(() => {
    dependencies.transaction.mockClear();
    dependencies.profile = { key: "sandbox", siteId: 1, providerKey: "@test/provider/main", providerAddonId: "@test/provider", mode: "test", credentialReferences: {},
      merchantIdentity: "acct_test", revision: 1, enabled: true, retired: false, probedAt: "2026-11-22T08:00:00.000Z",
      features: { CHF: recording },
      grants: [{ consumerAddonId: manifest.addonId, operations: ["read", "method-read", "subscription-read", "settlement-read"],
        merchantActions: { capture: policy, cancel: policy, refund: policy, profileRefresh: policy } }] } as unknown as PhisPaymentProfile;
    dependencies.payment = { record: { id: "payment-1", profileKey: "sandbox", status: "captured" }, consumerAddonId: manifest.addonId, siteId: 1 } as PhisStoredPayment;
  });
  const hook = () => buildPhisPaymentsCapability({ scope: { siteId: 1, siteKey: "demo", consumerAddonId: manifest.addonId }, manifest, authority: { kind: "hook" }, signal: new AbortController().signal });
  const selector = (tax: "none" | "merchant-of-record") => ({ basis: "final" as const, tax, discounts: 0, promotionCodes: "none" as const });

  it("answers a hook the recording of a currency, every policy, as Core stored it", async () => {
    expect(await hook().profileFeatures({ profileKey: "sandbox", currency: "CHF" })).toEqual(recording);
    expect(dependencies.transaction).not.toHaveBeenCalled();
  });

  it("chooses automatic before payment-request, by the interval's unit and length, from the recording", async () => {
    const choose = (tax: "none" | "merchant-of-record", interval: { unit: "month" | "year"; count: number }, modes = ["automatic", "payment-request"] as const) =>
      hook().chooseCollection({ profileKey: "sandbox", currency: "CHF", pricing: selector(tax), interval, modes });
    expect(await choose("none", { unit: "month", count: 1 })).toEqual({ mode: "automatic", features: { units: ["month"], maxDays: 31 } });
    // Three months are longer than the 31 days automatic runs: the next mode the plan allows.
    expect((await choose("none", { unit: "month", count: 3 }))?.mode).toBe("payment-request");
    expect((await choose("none", { unit: "year", count: 1 }))?.mode).toBe("payment-request");
    expect(await choose("none", { unit: "year", count: 1 }, ["automatic"] as never)).toBeNull();
    expect((await choose("merchant-of-record", { unit: "year", count: 1 }))?.mode).toBe("payment-request");
    expect(await choose("merchant-of-record", { unit: "month", count: 1 })).toBeNull();
    // provider-managed is never answered until it is built.
    expect(await choose("none", { unit: "month", count: 1 }, ["provider-managed"] as never)).toBeNull();
    await expect(choose("none", { unit: "month", count: 1 }, ["someday"] as never)).rejects.toMatchObject({ code: "invalid_input" });
    expect(await hook().chooseCollection({ profileKey: "sandbox", currency: "EUR", pricing: selector("none"), interval: { unit: "month", count: 1 }, modes: ["automatic"] })).toBeNull();
  });

  it("answers null in a currency never asked, and nothing outside the grant", async () => {
    expect(await hook().profileFeatures({ profileKey: "sandbox", currency: "EUR" })).toBeNull();
    await expect(hook().profileFeatures({ profileKey: "sandbox", currency: "eur" })).rejects.toMatchObject({ code: "invalid_input" });
    (dependencies.profile as { grants: unknown[] }).grants = [];
    await expect(hook().profileFeatures({ profileKey: "sandbox", currency: "CHF" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("answers no features of a profile that is not enabled", async () => {
    (dependencies.profile as PhisPaymentProfile).enabled = false;
    await expect(hook().profileFeatures({ profileKey: "sandbox", currency: "CHF" })).rejects.toMatchObject({ code: "profile_unavailable" });
  });

  it.each([
    ["listMethods", (api: ReturnType<typeof hook>) => api.listMethods({ profileKey: "sandbox", amount: { currency: "CHF", minor: "100" }, captureMode: "automatic", checkoutKind: "redirect",
      pricing: { basis: "final", tax: "none", discounts: 0, promotionCodes: "none" } })],
    ["get", (api: ReturnType<typeof hook>) => api.get("payment-1")],
    ["getOperation", (api: ReturnType<typeof hook>) => api.getOperation("operation-1")],
    ["getRefund", (api: ReturnType<typeof hook>) => api.getRefund("refund-1")],
    ["getStoredMethod", (api: ReturnType<typeof hook>) => api.getStoredMethod("method-1")],
    ["listStoredMethods", (api: ReturnType<typeof hook>) => api.listStoredMethods({ profileKey: "sandbox", payerReference: "payer-1" })],
    ["getSubscription", (api: ReturnType<typeof hook>) => api.getSubscription("subscription-1")],
    ["listSubscriptionPeriods", (api: ReturnType<typeof hook>) => api.listSubscriptionPeriods("subscription-1")],
    ["listSubscriptionChanges", (api: ReturnType<typeof hook>) => api.listSubscriptionChanges("subscription-1")],
    ["subscriptionCredit", (api: ReturnType<typeof hook>) => api.subscriptionCredit("subscription-1")],
    ["listSettlements", (api: ReturnType<typeof hook>) => api.listSettlements("payment-1")],
    ["refreshProfileFeatures", (api: ReturnType<typeof hook>) => api.refreshProfileFeatures({ profileKey: "sandbox", currencies: ["CHF"] })],
    ["listProfiles", (api: ReturnType<typeof hook>) => api.listProfiles()],
  ] as const)("keeps %s refused to a hook, under a grant that holds it", async (_name, call) => {
    await expect(call(hook())).rejects.toMatchObject({ code: "forbidden" });
    expect(dependencies.transaction).not.toHaveBeenCalled();
  });

  it("answers settlements only to an acting Admin or Accountant, and never to an operator, a job or an event", async () => {
    const as = (authority: PhisPaymentAuthority) => buildPhisPaymentsCapability({ scope: { siteId: 1, siteKey: "demo", consumerAddonId: manifest.addonId }, manifest,
      authority, signal: new AbortController().signal });
    dependencies.billing = false;
    for (const authority of [{ kind: "request", operator: false, actorUserId: 7 }, { kind: "request", operator: true, actorUserId: null },
      { kind: "job", id: "settle" }, { kind: "event", id: "payment.changed" }] as PhisPaymentAuthority[]) {
      await expect(as(authority).listSettlements("payment-1")).rejects.toMatchObject({ code: "forbidden" });
    }
    dependencies.billing = true;
    // Past the role: the grant decides next, and a payment without one is nobody's to list.
    (dependencies.profile as { grants: { operations: string[] }[] }).grants[0]!.operations = ["read"];
    expect(await as({ kind: "request", operator: false, actorUserId: 7 }).listSettlements("payment-1")).toEqual([]);
  });

  it("refreshes only under the grant's profileRefresh policy", async () => {
    const request = (actorUserId: number) => buildPhisPaymentsCapability({ scope: { siteId: 1, siteKey: "demo", consumerAddonId: manifest.addonId }, manifest,
      authority: { kind: "request", operator: false, actorUserId }, signal: new AbortController().signal });
    dependencies.role = false; dependencies.admin = false;
    await expect(request(7).refreshProfileFeatures({ profileKey: "sandbox", currencies: ["CHF"] })).rejects.toMatchObject({ code: "forbidden" });
    const grant = (dependencies.profile as PhisPaymentProfile).grants[0]!;
    (dependencies.profile as { grants: unknown[] }).grants = [{ ...grant, merchantActions: { capture: policy, cancel: policy, refund: policy } }];
    dependencies.role = true;
    await expect(request(7).refreshProfileFeatures({ profileKey: "sandbox", currencies: ["CHF"] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(request(7).refreshProfileFeatures({ profileKey: "sandbox", currencies: ["CHF", "CHF"] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(request(7).refreshProfileFeatures({ profileKey: "sandbox", currencies: [] })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("the profiles a consumer may choose from", () => {
  const manifest = { addonId: "@test/shop", roles: [], jobs: [], eventHandlers: [] } as unknown as PhisAddonManifestV1;
  it("names the profiles granted to this consumer on this Site, in one read", async () => {
    const summary = { profileKey: "stripe-ch", providerKey: "@test/provider/main", providerAddonId: "@test/provider", mode: "test", state: "enabled" };
    dependencies.granted.mockReset(); dependencies.granted.mockResolvedValue([summary]);
    const api = buildPhisPaymentsCapability({ scope: { siteId: 3, siteKey: "demo", consumerAddonId: manifest.addonId }, manifest,
      authority: { kind: "request", operator: false, actorUserId: 7 }, signal: new AbortController().signal });
    expect(await api.listProfiles()).toEqual([summary]);
    expect(dependencies.granted).toHaveBeenCalledOnce();
    expect(dependencies.granted).toHaveBeenCalledWith({}, 3, "@test/shop");
  });
});
