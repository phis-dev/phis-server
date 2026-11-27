import {
  PhisPaymentFeatureFlag, PhisPaymentPricingFeatureFlag, type PhisPaymentCurrencyFeatures, type PhisPaymentFeatures, type PhisPaymentPricingFeatures,
} from "@phis/contracts/payments";

/**
 * What a test Provider declares, in the shape of phis-contracts 0.9: the yes/no facts as flags, a currency
 * declaration on every method. Shared by the unit and the pg tests so a fake Provider is written once.
 */

/** A method that converts nothing, settles in nothing it names and reports no settlements. */
export const TEST_CURRENCY_FEATURES: PhisPaymentCurrencyFeatures = Object.freeze({
  amounts: "single", conversion: "none", conversionCurrencies: [], conversionCost: null, settlementCurrencies: [], flags: 0,
});

/** Every method flag: partial capture, cancel, refund and partial refund. */
export const TEST_ALL_METHOD_FLAGS = PhisPaymentFeatureFlag.PartialCapture | PhisPaymentFeatureFlag.Cancel
  | PhisPaymentFeatureFlag.Refund | PhisPaymentFeatureFlag.PartialRefund;

export function testPricingFeatures(patch: Partial<PhisPaymentPricingFeatures> & { collectsCustomerDetails?: boolean; collectsTaxIds?: boolean } = {}): PhisPaymentPricingFeatures {
  const { collectsCustomerDetails = false, collectsTaxIds = false, ...rest } = patch;
  return {
    bases: ["final"], tax: ["none"], maxDiscounts: 0, promotionCodes: "none", merchantOfRecord: null,
    flags: (collectsCustomerDetails ? PhisPaymentPricingFeatureFlag.CollectsCustomerDetails : 0) | (collectsTaxIds ? PhisPaymentPricingFeatureFlag.CollectsTaxIds : 0),
    ...rest,
  };
}

export function testMethodFeatures(patch: Partial<PhisPaymentFeatures> = {}): PhisPaymentFeatures {
  return {
    captureModes: ["automatic"], checkoutKinds: ["redirect"], flags: PhisPaymentFeatureFlag.Cancel | PhisPaymentFeatureFlag.Refund | PhisPaymentFeatureFlag.PartialRefund,
    pricing: testPricingFeatures(), currency: TEST_CURRENCY_FEATURES, ...patch,
  };
}

/** The interval features of a mode that runs every unit without a limit of its own. */
export const TEST_EVERY_INTERVAL = Object.freeze({ units: ["day", "week", "month", "year"] as const, maxDays: null });
