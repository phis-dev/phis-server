import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import type { PhisPaymentAuthority, PhisPaymentProfile, PhisStoredPayment } from "./types.ts";
import { buildPhisPaymentsCapability } from "./runtime.ts";
vi.mock("../addons/event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: vi.fn() }));

const dependencies = vi.hoisted(() => ({ profile: null as unknown, payment: null as unknown,
  role: false, admin: false, transaction: vi.fn(async () => { throw new Error("authorized-reservation-boundary"); }) }));
vi.mock("../db", () => ({ getPool: () => ({}) }));
vi.mock("../../db/payments.mts", () => ({ readPhisPayment: async () => dependencies.payment, readPhisPaymentProfile: async () => dependencies.profile,
  readPhisPaymentOperation: async () => ({ record: { id: "operation-1", paymentId: "payment-1" } }), readPhisPaymentRefund: async () => ({ record: { id: "refund-1", paymentId: "payment-1" } }),
  readPhisPaymentStoredMethod: async () => ({ record: { id: "method-1", profileKey: "sandbox" } }) }));
vi.mock("../../db/payment-subscriptions.mts", () => ({ readPhisPaymentSubscription: async () => ({ record: { id: "subscription-1", profileKey: "sandbox" } }) }));
vi.mock("../db-transaction.ts", () => ({ withPoolTransaction: (...args: unknown[]) => dependencies.transaction(...args as []) }));
vi.mock("../addons/site-access.ts", () => ({ holdsPhisSiteAccess: async () => dependencies.admin }));
vi.mock("../addons/roles-capability.ts", () => ({ buildPhisAddonRolesCapability: () => ({ has: async (role: string) => dependencies.role && role === "merchant" }) }));

describe("Core-bound Payment merchant authority", () => {
  const manifest = { addonId: "@test/shop", roles: [{ name: "merchant" }], jobs: [{ id: "settle" }], eventHandlers: [{ event: "payment.changed" }] } as PhisAddonManifestV1;
  beforeEach(() => {
    dependencies.admin = false; dependencies.role = false; dependencies.transaction.mockClear();
    const policy = { roles: ["merchant"], jobs: ["settle"], events: ["payment.changed"] };
    dependencies.profile = { key: "sandbox", siteId: 1, providerKey: "@test/provider/main", providerAddonId: "@test/provider", mode: "test",
      credentialReferences: {}, merchantIdentity: "acct_test", revision: 1, enabled: true, retired: false, probedAt: "2026-10-04T00:00:00.000Z", methods: {}, grants: [{ consumerAddonId: manifest.addonId, operations: ["read", "refund"], merchantActions: { capture: policy, cancel: policy, refund: policy } }] } as PhisPaymentProfile;
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

describe("a profile's reach, the one operation a hook may call", () => {
  const manifest = { addonId: "@test/shop", roles: [{ name: "merchant" }], jobs: [], eventHandlers: [{ event: "payment.changed" }] } as unknown as PhisAddonManifestV1;
  const policy = { roles: ["merchant"], jobs: [], events: [] };
  const pricing = (merchantOfRecord: unknown) => ({ bases: ["final"], tax: merchantOfRecord ? ["none", "merchant-of-record"] : ["none"], maxDiscounts: 0, promotionCodes: "none",
    collectsCustomerDetails: false, collectsTaxIds: false, merchantOfRecord });
  const method = (methodKey: string, merchantOfRecord: unknown, checkoutKinds = ["redirect"]) => ({ methodKey, title: methodKey,
    features: { captureModes: ["automatic"], checkoutKinds, canPartialCapture: false, canCancel: true, canRefund: true, canPartialRefund: true, pricing: pricing(merchantOfRecord) } });
  beforeEach(() => {
    dependencies.transaction.mockClear();
    dependencies.profile = { key: "sandbox", siteId: 1, providerKey: "@test/provider/main", providerAddonId: "@test/provider", mode: "test", credentialReferences: {},
      merchantIdentity: "acct_test", revision: 1, enabled: true, retired: false, probedAt: "2026-11-22T08:00:00.000Z",
      methods: { CHF: { probedAt: "2026-11-21T10:00:00.000Z", methods: [
        method("card", { countries: ["CH", "DE"], taxCategories: ["digital-goods"], businessTaxIds: ["charge"] }),
        method("wallet", { countries: ["DE", "US"], taxCategories: ["digital-service", "digital-goods"], businessTaxIds: ["reverse-charge", "charge"] }),
        method("twint", null),
        // A method no hosted checkout can use reaches nobody a Shop could send there.
        method("embedded", { countries: ["JP"], taxCategories: ["general"], businessTaxIds: ["charge"] }, ["provider-ui"]),
      ] } },
      grants: [{ consumerAddonId: manifest.addonId, operations: ["read", "method-read", "subscription-read"],
        merchantActions: { capture: policy, cancel: policy, refund: policy, profileRefresh: policy } }] } as unknown as PhisPaymentProfile;
    dependencies.payment = { record: { id: "payment-1", profileKey: "sandbox", status: "captured" }, consumerAddonId: manifest.addonId, siteId: 1 } as PhisStoredPayment;
  });
  const hook = () => buildPhisPaymentsCapability({ scope: { siteId: 1, siteKey: "demo", consumerAddonId: manifest.addonId }, manifest, authority: { kind: "hook" }, signal: new AbortController().signal });

  it("answers a hook the recorded reach: the union of the methods, each value once, in the order first met", async () => {
    expect(await hook().profileReach({ profileKey: "sandbox", currency: "CHF" })).toEqual({ currency: "CHF", probedAt: "2026-11-21T10:00:00.000Z", merchantOfRecord: {
      countries: ["CH", "DE", "US"], taxCategories: ["digital-goods", "digital-service"], businessTaxIds: ["charge", "reverse-charge"] } });
    expect(dependencies.transaction).not.toHaveBeenCalled();
  });

  it("answers null in a currency never asked, and nothing outside the grant", async () => {
    expect(await hook().profileReach({ profileKey: "sandbox", currency: "EUR" })).toBeNull();
    await expect(hook().profileReach({ profileKey: "sandbox", currency: "eur" })).rejects.toMatchObject({ code: "invalid_input" });
    (dependencies.profile as { grants: unknown[] }).grants = [];
    await expect(hook().profileReach({ profileKey: "sandbox", currency: "CHF" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("answers no reach of a profile that is not enabled", async () => {
    (dependencies.profile as PhisPaymentProfile).enabled = false;
    await expect(hook().profileReach({ profileKey: "sandbox", currency: "CHF" })).rejects.toMatchObject({ code: "profile_unavailable" });
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
    ["refreshProfileReach", (api: ReturnType<typeof hook>) => api.refreshProfileReach({ profileKey: "sandbox", currencies: ["CHF"] })],
  ] as const)("keeps %s refused to a hook, under a grant that holds it", async (_name, call) => {
    await expect(call(hook())).rejects.toMatchObject({ code: "forbidden" });
    expect(dependencies.transaction).not.toHaveBeenCalled();
  });

  it("refreshes only under the grant's profileRefresh policy", async () => {
    const request = (actorUserId: number) => buildPhisPaymentsCapability({ scope: { siteId: 1, siteKey: "demo", consumerAddonId: manifest.addonId }, manifest,
      authority: { kind: "request", operator: false, actorUserId }, signal: new AbortController().signal });
    dependencies.role = false; dependencies.admin = false;
    await expect(request(7).refreshProfileReach({ profileKey: "sandbox", currencies: ["CHF"] })).rejects.toMatchObject({ code: "forbidden" });
    const grant = (dependencies.profile as PhisPaymentProfile).grants[0]!;
    (dependencies.profile as { grants: unknown[] }).grants = [{ ...grant, merchantActions: { capture: policy, cancel: policy, refund: policy } }];
    dependencies.role = true;
    await expect(request(7).refreshProfileReach({ profileKey: "sandbox", currencies: ["CHF"] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(request(7).refreshProfileReach({ profileKey: "sandbox", currencies: ["CHF", "CHF"] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(request(7).refreshProfileReach({ profileKey: "sandbox", currencies: [] })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
