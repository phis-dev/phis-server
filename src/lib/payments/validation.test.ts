import { describe, expect, it, vi } from "vitest";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import { buildPhisPaymentProviderContext } from "./provider.ts";
import { phisPaymentReturnUrl, validatePhisPaymentMoney, validatePhisPaymentProfileDraft, validatePhisPaymentProviderProbe } from "./validation.ts";
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
    const features = { captureModes: ["automatic"] as const, checkoutKinds: ["redirect"] as const, canPartialCapture: false, canCancel: true, canRefund: true, canPartialRefund: true, extra: "private-provider-data" };
    const probe = { merchantIdentity: "acct_test", mode: "test" as const, methods: [{ methodKey: "card", title: "Card", features, extra: "private-provider-data" }] };
    const normalized = validatePhisPaymentProviderProbe(probe, { merchantIdentity: "acct_test", mode: "test" });
    expect(JSON.stringify(normalized)).not.toContain("private-provider-data");
    expect(() => validatePhisPaymentProviderProbe({ ...probe, methods: [...probe.methods, ...probe.methods] }, { merchantIdentity: "acct_test", mode: "test" })).toThrow();
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
