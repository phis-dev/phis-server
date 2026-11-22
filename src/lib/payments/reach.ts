import type {
  PhisPaymentMerchantOfRecordFeatures, PhisPaymentProfileReach, PhisPaymentProviderProbe, PhisPaymentProviderV1,
} from "@phis/contracts/payments";
import type { PhisPaymentProfile } from "./types.ts";

type ReachProbe = Omit<Parameters<PhisPaymentProviderV1["probe"]>[0], "signal">;

/**
 * What Core asks a Provider when it records a profile in one currency: 100 minor units of it, a hosted
 * checkout with automatic capture, and a final price the Provider adds nothing to.
 *
 * `tax: "none"` because every method supports it (`PhisPaymentPricingFeatures.tax` always includes it),
 * so the Provider answers every method it has, each with its own `pricing.merchantOfRecord`. Asked for
 * `merchant-of-record` instead, a Provider may leave out what does not sell so -- Stripe drops TWINT --
 * and the recording would no longer be the profile's methods but one selection of them.
 */
export function phisPaymentReachProbe(currency: string): ReachProbe {
  return {
    amount: { currency, minor: "100" }, captureMode: "automatic", checkoutKind: "redirect",
    pricing: { basis: "final", tax: "none", discounts: 0, promotionCodes: "none" },
  };
}

/** Each value once, in the order first met: the same recording always reads the same. */
function union<T>(lists: readonly (readonly T[])[]): T[] {
  return [...new Set(lists.flat())];
}

/**
 * The reach of the methods one probe answered: the union of what each of them sells as Merchant of
 * Record, over the methods a payment could use as the probe asked (automatic capture, hosted checkout).
 * `null` where none sells so.
 */
export function phisPaymentReachOf(currency: string, probedAt: string, methods: PhisPaymentProviderProbe["methods"]): PhisPaymentProfileReach {
  const asked = phisPaymentReachProbe(currency);
  const reaches = methods
    .filter(method => method.features.captureModes.includes(asked.captureMode) && method.features.checkoutKinds.includes(asked.checkoutKind))
    .flatMap(method => method.features.pricing.merchantOfRecord ? [method.features.pricing.merchantOfRecord] : []);
  const merchantOfRecord: PhisPaymentMerchantOfRecordFeatures | null = reaches.length === 0 ? null : {
    countries: union(reaches.map(reach => reach.countries)),
    taxCategories: union(reaches.map(reach => reach.taxCategories)),
    businessTaxIds: union(reaches.map(reach => reach.businessTaxIds)),
  };
  return { currency, probedAt, merchantOfRecord };
}

/** The profile's reach in one currency as Core last recorded it; `null` where it was never asked in that currency. */
export function readPhisPaymentProfileReach(profile: Pick<PhisPaymentProfile, "methods">, currency: string): PhisPaymentProfileReach | null {
  const recorded = profile.methods && Object.hasOwn(profile.methods, currency) ? profile.methods[currency] : undefined;
  return recorded ? phisPaymentReachOf(currency, recorded.probedAt, recorded.methods) : null;
}
