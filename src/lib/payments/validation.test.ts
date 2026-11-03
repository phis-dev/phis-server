import { describe, expect, it, vi } from "vitest";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import { buildPhisPaymentProviderContext } from "./provider.ts";
import { phisPaymentMethodSupports, phisPaymentPricingSelector, phisPaymentReturnUrl, validatePhisPaymentMoney, validatePhisPaymentPricing,
  validatePhisPaymentProfileDraft, validatePhisPaymentProviderProbe } from "./validation.ts";
import type { PhisPaymentProfile } from "./types.ts";

describe("Payment authority inputs", () => {
  it("keeps currency exponents independent of display rounding", () => {
    expect(validatePhisPaymentMoney({ currency: "CHF", minor: "1990" })).toBe(2);
    expect(validatePhisPaymentMoney({ currency: "EUR", minor: "1990" })).toBe(2);
    expect(validatePhisPaymentMoney({ currency: "JPY", minor: "1990" })).toBe(0);
    expect(validatePhisPaymentMoney({ currency: "MGA", minor: "1990" })).toBe(2);
    expect(validatePhisPaymentMoney({ currency: "KWD", minor: "1990" })).toBe(3);
    for (const currency of ["chf", "ZZZ", "XXX"]) expect(() => validatePhisPaymentMoney({ currency, minor: "1" })).toThrow();
    for (const minor of ["0", "01", "1.2", "-1", "1e2", "10000000000000000"]) expect(() => validatePhisPaymentMoney({ currency: "CHF", minor })).toThrow();
  });
  it("copies only public method facts out of a Provider probe", () => {
    const pricing = { bases: ["final"] as const, tax: ["none"] as const, maxDiscounts: 0, promotionCodes: "none" as const, collectsCustomerDetails: false, collectsTaxIds: false, extra: "private-provider-data" };
    const features = { captureModes: ["automatic"] as const, checkoutKinds: ["redirect"] as const, canPartialCapture: false, canCancel: true, canRefund: true, canPartialRefund: true, pricing, extra: "private-provider-data" };
    const probe = { merchantIdentity: "acct_test", mode: "test" as const, methods: [{ methodKey: "card", title: "Card", features, extra: "private-provider-data" }] };
    const normalized = validatePhisPaymentProviderProbe(probe, { merchantIdentity: "acct_test", mode: "test" });
    expect(JSON.stringify(normalized)).not.toContain("private-provider-data");
    expect(() => validatePhisPaymentProviderProbe({ ...probe, methods: [...probe.methods, ...probe.methods] }, { merchantIdentity: "acct_test", mode: "test" })).toThrow();
    // Every Provider supports the fixed-total policy; a probe that withholds it is refused.
    const withheld = { ...probe, methods: [{ ...probe.methods[0]!, features: { ...features, pricing: { ...pricing, bases: ["net"] } } }] };
    expect(() => validatePhisPaymentProviderProbe(withheld as unknown as typeof probe, { merchantIdentity: "acct_test", mode: "test" })).toThrow();
  });
  it("normalizes a pricing policy and ties the base amount to its lines", () => {
    expect(validatePhisPaymentPricing({ basis: "final", tax: "none" }, { currency: "CHF", minor: "1990" })).toEqual({ basis: "final", tax: "none" });
    expect(() => validatePhisPaymentPricing({ basis: "final", tax: "none", promotionCodes: "none" }, { currency: "CHF", minor: "1990" })).toThrow();
    const line = { reference: "sku-1", description: "Widget", quantity: 3, unitMinor: "1000", taxCategory: "general", providerTaxCodes: { "@phis/stripe/stripe": "txcd_99999999" } };
    const policy = { basis: "net", tax: "provider", lineItems: [line], shipping: { minor: "500", taxCategory: "shipping" }, discounts: [{ reference: "d1", label: "Deal", minor: "250" }], promotionCodes: "none", customer: null };
    const normalized = validatePhisPaymentPricing(policy, { currency: "CHF", minor: "3250" });
    expect(normalized).toEqual(policy);
    expect(phisPaymentPricingSelector(normalized)).toEqual({ basis: "net", tax: "provider", discounts: 1, promotionCodes: "none" });
    expect(() => validatePhisPaymentPricing(policy, { currency: "CHF", minor: "3500" })).toThrow();
    expect(() => validatePhisPaymentPricing({ ...policy, discounts: [{ reference: "d1", label: "Deal", minor: "4000" }] }, { currency: "CHF", minor: "1" })).toThrow();
    expect(() => validatePhisPaymentPricing({ ...policy, lineItems: [{ ...line, taxCategory: "luxury" }] }, { currency: "CHF", minor: "3250" })).toThrow();
    expect(() => validatePhisPaymentPricing({ ...policy, lineItems: [{ ...line, quantity: 1.5 }] }, { currency: "CHF", minor: "1750" })).toThrow();
    expect(() => validatePhisPaymentPricing({ ...policy, customer: { country: "ch", postalCode: null, region: null, addressSource: "billing", taxIds: [] } }, { currency: "CHF", minor: "3250" })).toThrow();
  });
  it("matches a policy against a method's pricing features", () => {
    const features = { bases: ["final", "net"] as const, tax: ["none", "provider"] as const, maxDiscounts: 1, promotionCodes: "alone" as const, collectsCustomerDetails: true, collectsTaxIds: true };
    const selector = { basis: "net" as const, tax: "provider" as const, discounts: 1, promotionCodes: "none" as const };
    expect(phisPaymentMethodSupports(features, selector)).toBe(true);
    expect(phisPaymentMethodSupports(features, { ...selector, discounts: 0, promotionCodes: "provider" })).toBe(true);
    expect(phisPaymentMethodSupports(features, { ...selector, promotionCodes: "provider" })).toBe(false);
    expect(phisPaymentMethodSupports({ ...features, promotionCodes: "with-discounts" }, { ...selector, promotionCodes: "provider" })).toBe(true);
    expect(phisPaymentMethodSupports(features, { ...selector, tax: "merchant-of-record" })).toBe(false);
    expect(phisPaymentMethodSupports(features, { ...selector, discounts: 2 })).toBe(false);
  });
  it("constructs callbacks solely from the configured Site origin", () => {
    expect(phisPaymentReturnUrl("https://shop.example/old", "/de/return?order=opaque", "payment-1"))
      .toBe("https://shop.example/de/return?order=opaque&paymentId=payment-1");
    for (const path of ["//evil.example/", "/\\evil.example", "https://evil.example", "/return#bad", "javascript:alert(1)"]) {
      expect(() => phisPaymentReturnUrl("https://shop.example", path, "id")).toThrow();
    }
    expect(() => phisPaymentReturnUrl("http://shop.example", "/return", "id")).toThrow();
  });
  it("hands a Provider only its own Site's named credentials", async () => {
    const profile: PhisPaymentProfile = { key: "sandbox", mode: "test", grants: [], siteId: 1, merchantIdentity: "acct_test", revision: 1, enabled: true, retired: false, probedAt: null, methods: null, providerKey: "@phis/stripe/stripe", providerAddonId: "@phis/stripe", credentialReferences: {
      apiKey: "site:demo:addon:@phis/stripe:sandbox-api", webhookSecret: "site:demo:addon:@phis/stripe:sandbox-hook",
    } };
    const read = vi.fn(async (ref: string) => ref.endsWith("-api") ? "test-api-value" : "test-webhook-value");
    const context = buildPhisPaymentProviderContext(profile, "demo", read);
    expect(Object.keys(context).sort()).toEqual(["providerKey", "readCredentials"]);
    expect(context.readCredentials).toHaveLength(0);
    expect(await context.readCredentials()).toEqual({ apiKey: "test-api-value", webhookSecret: "test-webhook-value" });
    for (const reference of ["site:other:addon:@phis/stripe:sandbox-api", "site:demo:core:sandbox-api", "site:demo:addon:@phis/mollie:sandbox-api", "addon:@phis/stripe:sandbox-api"]) {
      expect(() => buildPhisPaymentProviderContext({ ...profile, credentialReferences: { apiKey: reference } }, "demo", read)).toThrow();
    }
  });
  it("refuses grants for undeclared roles, jobs, events or consumers without owner events", () => {
    const provider = { addonId: "@phis/stripe", serviceProviders: [{ serviceKind: "@phis/server/service/payments", providerKey: "@phis/stripe/stripe" }] } as PhisAddonManifestV1;
    const consumer = { addonId: "@test/consumer", requiredCoreCapabilities: ["@phis/server/payments:v1"], roles: [{ name: "merchant" }], jobs: [{ id: "settle" }], eventHandlers: [{ event: "payment.changed" }] } as PhisAddonManifestV1;
    const empty = { roles: [], jobs: [], events: [] };
    const draft = { key: "test", providerKey: "@phis/stripe/stripe", mode: "test", credentialReferences: { apiKey: "site:demo:addon:@phis/stripe:sandbox-api" },
      grants: [{ consumerAddonId: consumer.addonId, operations: ["read", "refund"], merchantActions: { capture: empty, cancel: empty, refund: { ...empty, roles: ["merchant"] } } }] };
    expect(validatePhisPaymentProfileDraft(draft, "demo", provider, { [consumer.addonId]: consumer })).toEqual(draft);
    const invalid = structuredClone(draft); invalid.grants[0]!.merchantActions.refund.roles = ["admin-of-another-addon"];
    expect(() => validatePhisPaymentProfileDraft(invalid, "demo", provider, { [consumer.addonId]: consumer })).toThrow();
    expect(() => validatePhisPaymentProfileDraft(draft, "demo", provider, { [consumer.addonId]: { ...consumer, eventHandlers: [] } })).toThrow();
  });
});
