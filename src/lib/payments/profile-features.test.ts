import { describe, expect, it } from "vitest";
import { PhisPaymentCurrencyFeatureFlag, type PhisPaymentProviderV1 } from "@phis/contracts/payments";
import { choosePhisPaymentCollection, phisPaymentDeclaredPolicies, probePhisPaymentProfileCurrency } from "./profile-features.ts";
import { TEST_CURRENCY_FEATURES, TEST_EVERY_INTERVAL, testMethodFeatures, testPricingFeatures } from "../../../test/payment-features.ts";

const schedule = { ...TEST_EVERY_INTERVAL, changes: { timings: ["now"], proration: ["time-share"] }, methodReplacement: "provider-page", dunning: "provider", flags: 0 } as const;
const stored = { setup: ["with-payment"], chargeResult: "notified", flags: 0, perPayer: "many", pricing: testPricingFeatures() } as const;
const mor = { countries: ["DE"], taxCategories: ["digital-goods"], businessTaxIds: ["charge"] } as const;

/** A Provider that stores a card under `none`, sells as Merchant of Record without storing, and answers what it is asked. */
function provider() {
  const asked: { basis: string; tax: string; usage: string | undefined }[] = [];
  const answer: Pick<PhisPaymentProviderV1, "probe"> = {
    async probe(input) {
      asked.push({ basis: input.pricing.basis, tax: input.pricing.tax, usage: input.usage });
      const merchant = input.pricing.tax === "merchant-of-record";
      const card = {
        methodKey: "card", title: "Card",
        features: testMethodFeatures({
          pricing: testPricingFeatures({ tax: ["none", "merchant-of-record"], merchantOfRecord: mor }),
          stored: merchant ? null : stored,
          // A one-time probe that says nothing of collection: the recurring one does.
          collection: input.usage === "recurring"
            ? { automatic: merchant ? null : { units: ["month", "year"], maxDays: null }, paymentRequest: TEST_EVERY_INTERVAL, providerManaged: schedule }
            : null,
          currency: merchant ? { ...TEST_CURRENCY_FEATURES, conversion: "mandatory", conversionCurrencies: ["EUR"], conversionCost: "customer", settlementCurrencies: ["CHF"],
            flags: PhisPaymentCurrencyFeatureFlag.SettlementRecords } : { ...TEST_CURRENCY_FEATURES, settlementCurrencies: ["CHF"] },
          documents: merchant ? { kinds: [{ kind: "invoice", flags: 3 }], issuer: { kind: "provider", name: "Sold through Link, LLC", taxId: null } } : null,
        }),
      };
      return { merchantIdentity: "acct_test", mode: "test" as const, methods: [card] };
    },
  };
  return { asked, answer };
}

describe("recording a profile per pricing policy", () => {
  it("asks every policy the methods declare, in both usages, and records provider-managed as not usable", async () => {
    const { asked, answer } = provider();
    const probed = await probePhisPaymentProfileCurrency(answer, { merchantIdentity: null, mode: "test" }, "CHF", () => new AbortController().signal);
    expect(asked).toEqual([
      { basis: "final", tax: "none", usage: undefined },
      { basis: "final", tax: "none", usage: "recurring" },
      { basis: "final", tax: "merchant-of-record", usage: undefined },
      { basis: "final", tax: "merchant-of-record", usage: "recurring" },
    ]);
    expect(probed.policies.map(policy => `${policy.basis}/${policy.tax}`)).toEqual(["final/none", "final/merchant-of-record"]);
    const [none, merchant] = probed.policies;
    expect(none!.collection).toEqual({ automatic: { units: ["month", "year"], maxDays: null }, paymentRequest: TEST_EVERY_INTERVAL, providerManaged: null });
    expect(merchant!.collection).toEqual({ automatic: null, paymentRequest: TEST_EVERY_INTERVAL, providerManaged: null });
    expect(merchant!.currency.conversion).toBe("mandatory");
    expect(merchant!.currency.flags).toBe(PhisPaymentCurrencyFeatureFlag.SettlementRecords);
    expect(merchant!.documents?.issuer.name).toBe("Sold through Link, LLC");
    expect(merchant!.merchantOfRecord).toEqual(mor);
    expect(none!.merchantOfRecord).toEqual(mor);
  });

  it("refuses an answer for another merchant than the first", async () => {
    const { answer } = provider();
    let calls = 0;
    const turncoat: Pick<PhisPaymentProviderV1, "probe"> = { async probe(input) {
      const probe = await answer.probe(input);
      return calls++ === 0 ? probe : { ...probe, merchantIdentity: "acct_other" };
    } };
    await expect(probePhisPaymentProfileCurrency(turncoat, { merchantIdentity: null, mode: "test" }, "CHF", () => new AbortController().signal)).rejects.toThrow();
  });

  it("names final/none first and every declared basis and tax once", () => {
    const method = (bases: ("final" | "net")[], tax: ("none" | "provider" | "merchant-of-record")[]) => ({ methodKey: null, title: "m",
      features: testMethodFeatures({ pricing: testPricingFeatures({ bases, tax }) }) });
    expect(phisPaymentDeclaredPolicies([method(["final", "net"], ["none", "provider"]), method(["final"], ["none"])]).map(p => `${p.basis}/${p.tax}`))
      .toEqual(["final/none", "final/provider", "net/none", "net/provider"]);
  });

  it("answers no mode without a recording of the policy", () => {
    expect(choosePhisPaymentCollection(null, { basis: "final", tax: "none" }, { unit: "month", count: 1 }, ["automatic"])).toBeNull();
  });
});
