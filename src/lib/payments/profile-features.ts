import type {
  PhisPaymentCaptureMode, PhisPaymentCollectionFeatures, PhisPaymentCollectionMode, PhisPaymentCurrencyFeatures, PhisPaymentDocumentFeatures,
  PhisPaymentFeatures, PhisPaymentInterval, PhisPaymentIntervalFeatures, PhisPaymentMerchantOfRecordFeatures, PhisPaymentPolicyRecording,
  PhisPaymentPricingBasis, PhisPaymentPricingSelector, PhisPaymentProfileFeatures, PhisPaymentProviderProbe, PhisPaymentProviderV1,
  PhisPaymentTaxHandling,
} from "@phis/contracts/payments";
import { longestPhisPaymentPeriodDays } from "./schedule.ts";
import { validatePhisPaymentProviderProbe } from "./validation.ts";
import type { PhisPaymentProfile } from "./types.ts";

type FeatureProbe = Omit<Parameters<PhisPaymentProviderV1["probe"]>[0], "signal">;
type ProbedMethods = PhisPaymentProviderProbe["methods"];

/**
 * What Core asks a Provider when it records a profile in one currency under one pricing policy: 100 minor
 * units of it, a hosted checkout with automatic capture, no stated discount and no promotion code.
 *
 * The first question is always `final`/`none`, which every method supports
 * (`PhisPaymentPricingFeatures.tax` always includes `none`), so the Provider answers every method it has;
 * the policies to ask about next are read from what those methods declare (`phisPaymentDeclaredPolicies`).
 */
export function phisPaymentFeatureProbe(currency: string, basis: PhisPaymentPricingBasis = "final", tax: PhisPaymentTaxHandling = "none"): FeatureProbe {
  return {
    amount: { currency, minor: "100" }, captureMode: "automatic", checkoutKind: "redirect",
    pricing: { basis, tax, discounts: 0, promotionCodes: "none" },
  };
}

/**
 * Every pricing policy the methods of the first answer declare, `final`/`none` first: `pricing.bases` x
 * `pricing.tax`, `merchant-of-record` only where a method declares it. Each is asked once.
 */
export function phisPaymentDeclaredPolicies(methods: ProbedMethods): { basis: PhisPaymentPricingBasis; tax: PhisPaymentTaxHandling }[] {
  const seen = new Set<string>(["final/none"]);
  const policies: { basis: PhisPaymentPricingBasis; tax: PhisPaymentTaxHandling }[] = [{ basis: "final", tax: "none" }];
  for (const method of methods) {
    for (const basis of method.features.pricing.bases) {
      for (const tax of method.features.pricing.tax) {
        const key = `${basis}/${tax}`;
        if (!seen.has(key)) { seen.add(key); policies.push({ basis, tax }); }
      }
    }
  }
  return policies;
}

/** Each value once, in the order first met: the same recording always reads the same. */
function union<T>(lists: readonly (readonly T[])[]): T[] {
  return [...new Set(lists.flat())];
}

/** The widest of several declarations of one mode: every unit any of them runs, and the longest period. */
function unionIntervals(list: readonly (PhisPaymentIntervalFeatures | null | undefined)[]): PhisPaymentIntervalFeatures | null {
  const present = list.filter((entry): entry is PhisPaymentIntervalFeatures => !!entry);
  if (present.length === 0) return null;
  return {
    units: union(present.map(entry => entry.units)),
    maxDays: present.some(entry => entry.maxDays === null) ? null : Math.max(...present.map(entry => entry.maxDays!)),
  };
}

const CONVERSION_ORDER = ["none", "optional", "mandatory"] as const;

function unionCurrency(list: readonly PhisPaymentCurrencyFeatures[]): PhisPaymentCurrencyFeatures {
  // Of several methods the profile may meet any; a customer can meet the strictest conversion and its cost.
  const conversion = list.reduce<PhisPaymentCurrencyFeatures["conversion"]>((widest, entry) =>
    CONVERSION_ORDER.indexOf(entry.conversion) > CONVERSION_ORDER.indexOf(widest) ? entry.conversion : widest, "none");
  const costs = list.map(entry => entry.conversionCost);
  return {
    amounts: list.some(entry => entry.amounts === "per-currency") ? "per-currency" : "single",
    conversion,
    conversionCurrencies: conversion === "none" ? [] : union(list.map(entry => entry.conversionCurrencies)),
    conversionCost: conversion === "none" ? null : costs.includes("customer") ? "customer" : costs.includes("merchant") ? "merchant" : null,
    settlementCurrencies: union(list.map(entry => entry.settlementCurrencies)),
    flags: list.reduce((bits, entry) => bits | entry.flags, 0),
  };
}

function unionDocuments(list: readonly (PhisPaymentDocumentFeatures | null | undefined)[]): PhisPaymentDocumentFeatures | null {
  const present = list.filter((entry): entry is PhisPaymentDocumentFeatures => !!entry);
  if (present.length === 0) return null;
  const kinds = new Map<string, number>();
  for (const entry of present) for (const kind of entry.kinds) kinds.set(kind.kind, (kinds.get(kind.kind) ?? 0) | kind.flags);
  return {
    kinds: [...kinds].map(([kind, flags]) => ({ kind: kind as PhisPaymentDocumentFeatures["kinds"][number]["kind"], flags })),
    // Under one policy one party issues; the first method that says so is taken at its word.
    issuer: { ...present[0]!.issuer },
  };
}

/**
 * What a profile can do in one currency under one pricing policy: the union over the methods the Provider
 * answered for that policy that a hosted payment could use (automatic capture, redirect checkout).
 * `recurring` is the same question asked with `usage: "recurring"`; a method's `collection` is read from it
 * where the method is there, from the one-time answer otherwise. `provider-managed` is not built, so a
 * declaration of it is recorded as not usable (`null`).
 */
export function phisPaymentPolicyRecording(
  policy: { basis: PhisPaymentPricingBasis; tax: PhisPaymentTaxHandling },
  methods: ProbedMethods,
  recurring: ProbedMethods,
): PhisPaymentPolicyRecording {
  const asked = phisPaymentFeatureProbe("XXX", policy.basis, policy.tax);
  const usable = methods.filter(method => method.features.captureModes.includes(asked.captureMode) && method.features.checkoutKinds.includes(asked.checkoutKind));
  const collections: (PhisPaymentCollectionFeatures | null | undefined)[] = usable.map(method =>
    recurring.find(entry => entry.methodKey === method.methodKey)?.features.collection ?? method.features.collection);
  const automatic = unionIntervals(collections.map(entry => entry?.automatic));
  const paymentRequest = unionIntervals(collections.map(entry => entry?.paymentRequest));
  const reaches = usable.flatMap(method => method.features.pricing.merchantOfRecord ? [method.features.pricing.merchantOfRecord] : []);
  const merchantOfRecord: PhisPaymentMerchantOfRecordFeatures | null = reaches.length === 0 ? null : {
    countries: union(reaches.map(reach => reach.countries)),
    taxCategories: union(reaches.map(reach => reach.taxCategories)),
    businessTaxIds: union(reaches.map(reach => reach.businessTaxIds)),
  };
  return {
    basis: policy.basis,
    tax: policy.tax,
    captureModes: union(usable.map(method => method.features.captureModes)) as PhisPaymentCaptureMode[],
    collection: automatic || paymentRequest ? { automatic, paymentRequest, providerManaged: null } : null,
    currency: unionCurrency(usable.map(method => method.features.currency)),
    documents: unionDocuments(usable.map(method => method.features.documents)),
    merchantOfRecord,
  };
}

/** The profile's recording in one currency as Core last made it; `null` where it was never asked in that currency. */
export function readPhisPaymentProfileFeatures(profile: Pick<PhisPaymentProfile, "features">, currency: string): PhisPaymentProfileFeatures | null {
  const recorded = profile.features && Object.hasOwn(profile.features, currency) ? profile.features[currency] : undefined;
  return recorded ? structuredClone(recorded) : null;
}

/** Core's order of the collection modes (owner, 2026-11-27): the customer's convenience first. */
const COLLECTION_ORDER: readonly PhisPaymentCollectionMode[] = ["automatic", "provider-managed", "payment-request"];

/**
 * The first mode in Core's order that the consumer allows and the recording declares for the interval's
 * unit and length under the policy of `pricing`; `null` where none. `provider-managed` is never answered
 * until it is built.
 */
export function choosePhisPaymentCollection(
  recording: PhisPaymentProfileFeatures | null,
  pricing: Pick<PhisPaymentPricingSelector, "basis" | "tax">,
  interval: PhisPaymentInterval,
  modes: readonly PhisPaymentCollectionMode[],
): { mode: PhisPaymentCollectionMode; features: PhisPaymentIntervalFeatures } | null {
  const policy = recording?.policies.find(entry => entry.basis === pricing.basis && entry.tax === pricing.tax);
  if (!policy?.collection) return null;
  for (const mode of COLLECTION_ORDER) {
    if (!modes.includes(mode) || mode === "provider-managed") continue;
    const features = mode === "automatic" ? policy.collection.automatic : policy.collection.paymentRequest;
    if (phisPaymentIntervalFits(features, interval)) return { mode, features: structuredClone(features!) };
  }
  return null;
}

/** Whether a declared mode runs this interval: its unit, and its longest period at most `maxDays`. */
export function phisPaymentIntervalFits(features: PhisPaymentIntervalFeatures | null | undefined, interval: PhisPaymentInterval): boolean {
  return !!features && features.units.includes(interval.unit) && (features.maxDays === null || longestPhisPaymentPeriodDays(interval) <= features.maxDays);
}

/** Whether one method can collect a subscription of this interval in this mode, as it declared live. */
export function phisPaymentMethodCollects(features: PhisPaymentFeatures, mode: PhisPaymentCollectionMode, interval: PhisPaymentInterval): boolean {
  if (mode === "automatic") return !!features.stored && phisPaymentIntervalFits(features.collection?.automatic, interval);
  if (mode === "payment-request") return phisPaymentIntervalFits(features.collection?.paymentRequest, interval);
  return false;
}

/**
 * Asks the Provider about a profile in one currency, once per pricing policy its methods declare and in
 * both usages, and answers the policies to record. Every answer is validated as any probe is; an answer
 * for another merchant or mode than the first is refused. The caller records it
 * (`recordPhisPaymentProfileFeatures`); a Provider that fails throws what it threw.
 */
export async function probePhisPaymentProfileCurrency(
  provider: Pick<PhisPaymentProviderV1, "probe">,
  profile: Pick<PhisPaymentProfile, "merchantIdentity" | "mode">,
  currency: string,
  signal: () => AbortSignal,
): Promise<{ merchantIdentity: string; mode: "test" | "live"; methods: number; policies: PhisPaymentPolicyRecording[] }> {
  const first = validatePhisPaymentProviderProbe(await provider.probe({ ...phisPaymentFeatureProbe(currency), signal: signal() }), profile);
  const same = { merchantIdentity: first.merchantIdentity, mode: first.mode };
  const policies: PhisPaymentPolicyRecording[] = [];
  for (const policy of phisPaymentDeclaredPolicies(first.methods)) {
    const asked = phisPaymentFeatureProbe(currency, policy.basis, policy.tax);
    const oneTime = policy.basis === "final" && policy.tax === "none" ? first
      : validatePhisPaymentProviderProbe(await provider.probe({ ...asked, signal: signal() }), same);
    const recurring = validatePhisPaymentProviderProbe(await provider.probe({ ...asked, usage: "recurring", signal: signal() }), same);
    policies.push(phisPaymentPolicyRecording(policy, oneTime.methods, recurring.methods));
  }
  return { ...same, methods: first.methods.length, policies };
}
