import { isDeepStrictEqual } from "node:util";
import type {
  PhisPayment, PhisPaymentAddition, PhisPaymentCustomerDetails, PhisPaymentErrorCode, PhisPaymentMoney, PhisPaymentObservedTotals,
  PhisPaymentMerchantOfRecordFeatures, PhisPaymentPricing, PhisPaymentPricingFeatures, PhisPaymentPricingSelector, PhisPaymentProfileDraft, PhisPaymentProviderObservation,
  PhisPaymentProviderProbe, PhisPaymentProviderStoredMethod, PhisPaymentStoredFeatures, PhisPaymentTotals, PhisPaymentCheckoutExpiryFeatures,
  PhisPaymentCollectionFeatures, PhisPaymentCurrencyFeatures, PhisPaymentDocumentFeatures, PhisPaymentIntervalFeatures, PhisPaymentScheduleFeatures,
} from "@phis/contracts/payments";
import {
  PHIS_PAYMENT_CURRENCY_EXPONENTS, PhisPaymentAdditionFlag, PhisPaymentCurrencyFeatureFlag, PhisPaymentDocumentFeatureFlag, PhisPaymentFeatureFlag,
  PhisPaymentPricingFeatureFlag, PhisPaymentScheduleFeatureFlag, PhisPaymentStoredFeatureFlag,
} from "@phis/contracts/payments";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import {
  PHIS_PAYMENT_MAX_ADDITIONS, PHIS_PAYMENT_MAX_CHECKOUT_EXPIRY_SECONDS, PHIS_PAYMENT_MAX_DISCOUNTS, PHIS_PAYMENT_MAX_LINE_ITEMS,
  PHIS_PAYMENT_MAX_LINE_QUANTITY, PHIS_PAYMENT_MAX_PROVIDER_TAX_CODES, PHIS_PAYMENT_MAX_REFUNDS, PHIS_PAYMENT_MAX_TAX_IDS,
  PHIS_PAYMENT_TAX_CATEGORIES, PHIS_PAYMENT_TEXT_LENGTH,
} from "../constants/payments.ts";
import { parsePhiSecretReference } from "../secrets/reference.ts";
import type { PhisPaymentProfile, PhisStoredPayment } from "./types.ts";

export class PhisPaymentError extends Error {
  readonly code: PhisPaymentErrorCode;
  constructor(code: PhisPaymentErrorCode, message = "Payment operation could not be completed.") {
    super(message);
    this.code = code;
    this.name = "PhisPaymentError";
  }
}

export function requirePhisPaymentReference(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[^\s\x00-\x1f\x7f]{1,255}$/u.test(value)) throw new PhisPaymentError("invalid_input");
}

export function requirePhisPaymentMinor(value: unknown, positive = false): asserts value is string {
  if (typeof value !== "string" || !(positive ? /^[1-9][0-9]{0,15}$/ : /^(0|[1-9][0-9]{0,15})$/).test(value)) {
    throw new PhisPaymentError("invalid_input");
  }
}

/** A currency a payment accepts (`PHIS_PAYMENT_CURRENCY_EXPONENTS`), as the uppercase code it is stored under. */
export function requirePhisPaymentCurrency(value: unknown): string {
  if (typeof value !== "string" || !Object.hasOwn(PHIS_PAYMENT_CURRENCY_EXPONENTS, value)) throw new PhisPaymentError("invalid_input");
  return value;
}

export function validatePhisPaymentMoney(value: PhisPaymentMoney, positive = true): number {
  if (!value || typeof value.currency !== "string" || !Object.hasOwn(PHIS_PAYMENT_CURRENCY_EXPONENTS, value.currency)) throw new PhisPaymentError("invalid_input");
  requirePhisPaymentMinor(value.minor, positive);
  return PHIS_PAYMENT_CURRENCY_EXPONENTS[value.currency]!;
}

export function validatePhisPaymentProviderProbe(value: PhisPaymentProviderProbe, profile: Pick<PhisPaymentProfile, "merchantIdentity" | "mode">): PhisPaymentProviderProbe {
  try {
    requirePhisPaymentReference(value.merchantIdentity);
    if (value.mode !== profile.mode || (profile.merchantIdentity !== null && value.merchantIdentity !== profile.merchantIdentity)
      || !Array.isArray(value.methods) || value.methods.length > 100) throw new Error();
    const keys = new Set<string | null>();
    const methods = value.methods.map(method => {
      if (method.methodKey !== null) requirePhisPaymentReference(method.methodKey);
      const features = method.features;
      if (keys.has(method.methodKey) || typeof method.title !== "string" || method.title.length < 1 || method.title.length > 200
        || !features || !Array.isArray(features.captureModes) || features.captureModes.length > 2
        || features.captureModes.some((m: string) => m !== "automatic" && m !== "manual")
        || !Array.isArray(features.checkoutKinds) || features.checkoutKinds.length > 2
        || features.checkoutKinds.some((k: string) => k !== "redirect" && k !== "provider-ui")) throw new Error();
      const flags = requireFlags(features.flags, PhisPaymentFeatureFlag.PartialCapture | PhisPaymentFeatureFlag.Cancel | PhisPaymentFeatureFlag.Refund | PhisPaymentFeatureFlag.PartialRefund);
      // A partial refund is a refund: the one bit without the other says nothing a payment could do.
      if ((flags & PhisPaymentFeatureFlag.PartialRefund) !== 0 && (flags & PhisPaymentFeatureFlag.Refund) === 0) throw new Error();
      keys.add(method.methodKey);
      const stored = features.stored == null ? null : validateStoredFeatures(features.stored);
      const collection = features.collection == null ? null : validateCollectionFeatures(features.collection);
      // Charged without the customer means stored: a method that declares the one without the other cannot do it.
      if (collection?.automatic && !stored) throw new Error();
      return { methodKey: method.methodKey, title: method.title, features: {
        captureModes: [...features.captureModes], checkoutKinds: [...features.checkoutKinds], flags,
        pricing: validatePricingFeatures(features.pricing),
        stored,
        checkoutExpiry: features.checkoutExpiry == null ? null : validateCheckoutExpiryFeatures(features.checkoutExpiry),
        collection,
        currency: validateCurrencyFeatures(features.currency),
        documents: features.documents == null ? null : validateDocumentFeatures(features.documents),
      } };
    });
    return { merchantIdentity: value.merchantIdentity, mode: value.mode, methods };
  } catch { throw new PhisPaymentError("profile_unavailable", "Invalid Payment Provider probe."); }
}

export function phisPaymentReturnUrl(publicBaseUrl: string, returnPath: string, paymentId: string): string {
  let origin: URL;
  let result: URL;
  try {
    origin = new URL(publicBaseUrl);
    if (typeof returnPath !== "string" || returnPath.length > 2048 || !returnPath.startsWith("/") || returnPath.startsWith("//") || returnPath.includes("\\")) throw new Error();
    result = new URL(returnPath, origin.origin);
  } catch { throw new PhisPaymentError("invalid_input"); }
  if (result.origin !== origin.origin || result.hash || result.username || result.password
    || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) throw new PhisPaymentError("invalid_input");
  result.searchParams.set("paymentId", paymentId);
  return result.href;
}

/** The merchant actions a grant may leave out; absent, nobody may take them. */
const OPTIONAL_MERCHANT_ACTIONS = ["subscriptionEnd", "subscriptionPrice", "profileRefresh"] as const;

export function validatePhisPaymentProfileDraft(
  value: unknown, siteKey: string, provider: PhisAddonManifestV1, consumers: Readonly<Record<string, PhisAddonManifestV1>>,
): PhisPaymentProfileDraft {
  const fail = (): never => { throw new PhisPaymentError("invalid_input", "Invalid Payment profile references or grants."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const draft = value as PhisPaymentProfileDraft;
  if (Object.keys(draft).some(k => !["key", "providerKey", "mode", "credentialReferences", "grants"].includes(k))
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(draft.key ?? "")
    || !provider.serviceProviders.some(p => p.serviceKind === "@phis/server/service/payments" && p.providerKey === draft.providerKey)
    || !["test", "live"].includes(draft.mode) || !draft.credentialReferences || Array.isArray(draft.credentialReferences)
    || !Array.isArray(draft.grants) || draft.grants.length > 100) return fail();
  const references = Object.entries(draft.credentialReferences);
  if (references.length === 0 || references.length > 16) return fail();
  for (const [slot, reference] of references) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(slot) || typeof reference !== "string") return fail();
    const identity = parsePhiSecretReference(reference);
    if (!identity || identity.siteKey !== siteKey || identity.owner.kind !== "addon" || identity.owner.addonId !== provider.addonId) return fail();
  }
  const owners = new Set<string>();
  for (const grant of draft.grants) {
    const manifest = consumers[grant?.consumerAddonId];
    if (!manifest || owners.has(grant.consumerAddonId) || !manifest.requiredCoreCapabilities.includes("@phis/server/payments:v1")
      || !manifest.eventHandlers?.some(h => h.event === "payment.changed")
      || Object.keys(grant).some(k => !["consumerAddonId", "operations", "merchantActions"].includes(k))
      || !Array.isArray(grant.operations) || grant.operations.length === 0 || new Set(grant.operations).size !== grant.operations.length
      || grant.operations.some((op: string) => !["read", "create", "complete", "refresh", "capture", "cancel", "refund", "method-store", "method-read", "method-remove",
        "subscription-read", "subscription-create", "subscription-cancel", "subscription-change", "document-read", "settlement-read"].includes(op))
      || !grant.merchantActions || Object.keys(grant.merchantActions).some(k => !["capture", "cancel", "refund", ...OPTIONAL_MERCHANT_ACTIONS].includes(k))) return fail();
    owners.add(grant.consumerAddonId);
    // The three a payment has are required; the optional ones are checked where they are stated.
    for (const action of ["capture", "cancel", "refund", ...OPTIONAL_MERCHANT_ACTIONS.filter(optional => grant.merchantActions[optional] !== undefined)] as const) {
      const policy = grant.merchantActions[action];
      if (!policy || Object.keys(policy).some(k => !["roles", "jobs", "events"].includes(k))) return fail();
      for (const [kind, choices] of [["roles", manifest.roles?.map(r => r.name) ?? []], ["jobs", manifest.jobs.map(j => j.id)], ["events", manifest.eventHandlers?.map(e => e.event) ?? []]] as const) {
        const selected = policy[kind];
        if (!Array.isArray(selected) || selected.length > 100 || new Set(selected).size !== selected.length || selected.some(k => !choices.includes(k))) return fail();
      }
    }
  }
  return structuredClone(draft);
}

export function validatePhisPaymentObservation(payment: PhisStoredPayment, profile: PhisPaymentProfile, observation: PhisPaymentProviderObservation): void {
  const fail = (): never => { throw new PhisPaymentError("provider_unavailable", "Provider returned inconsistent Payment facts."); };
  const previous = payment.record;
  if (!observation || observation.merchantIdentity !== payment.merchantIdentity || observation.merchantIdentity !== profile.merchantIdentity
    || observation.mode !== previous.mode || !observation.binding
    || observation.amount?.currency !== previous.amount.currency || observation.amount.minor !== previous.amount.minor
    || !["awaiting_customer", "processing", "authorized", "captured", "canceled", "expired", "failed"].includes(observation.status)) return fail();
  try {
    if (payment.binding && (payment.binding.reference !== observation.binding.reference
      || Object.entries(payment.binding.data).some(([k, v]) => observation.binding.data[k] !== v))) return fail();
    requirePhisPaymentMinor(observation.authorizedMinor);
    requirePhisPaymentMinor(observation.capturedMinor);
    const payable = validateObservedTotals(previous, observation);
    if (BigInt(observation.capturedMinor) > payable || BigInt(observation.authorizedMinor) > payable
      || BigInt(observation.capturedMinor) < BigInt(previous.capturedMinor)
      || (previous.status === "captured" && observation.status !== "captured")
      || (observation.status !== "captured" && observation.capturedMinor !== "0")
      || (observation.status === "captured" && observation.capturedMinor === "0")
      || (observation.status !== "authorized" && observation.authorizedMinor !== "0")
      || (observation.status === "authorized" && observation.authorizedMinor === "0")
      || (previous.captureMode === "automatic" && observation.status === "authorized")) return fail();
    for (const binding of [observation.binding, ...observation.refunds.map(r => r.binding)]) {
      requirePhisPaymentReference(binding.reference);
      if (!binding.data || Array.isArray(binding.data) || Object.keys(binding.data).length > 32) return fail();
      for (const [key, value] of Object.entries(binding.data)) { requirePhisPaymentReference(key); requirePhisPaymentReference(value); }
    }
    if (observation.checkout) {
      // Provider UI requires a separately registered client adapter; this delivery admits redirects.
      if (observation.checkout.kind !== "redirect" || observation.status !== "awaiting_customer") return fail();
      const url = new URL(observation.checkout.url);
      if (url.protocol !== "https:" || url.username || url.password || url.href.length > 8192) return fail();
    }
    for (const date of [observation.authorizationExpiresAt, observation.checkout?.expiresAt ?? null]) {
      if (date !== null && (typeof date !== "string" || !Number.isFinite(Date.parse(date)))) return fail();
    }
    if (!Array.isArray(observation.refunds) || observation.refunds.length > PHIS_PAYMENT_MAX_REFUNDS) return fail();
    const bindings = new Set<string>(); const operations = new Set<string>(); let reserved = BigInt(0);
    for (const refund of observation.refunds) {
      requirePhisPaymentMinor(refund.minor, true);
      if (!["pending", "succeeded", "failed", "canceled"].includes(refund.status) || bindings.has(refund.binding.reference)) return fail();
      bindings.add(refund.binding.reference);
      if (refund.operationId !== null) {
        requirePhisPaymentReference(refund.operationId);
        if (operations.has(refund.operationId)) return fail(); operations.add(refund.operationId);
      }
      if (refund.status === "pending" || refund.status === "succeeded") reserved += BigInt(refund.minor);
      if (refund.additions !== null) {
        const additions = validateAdditions(refund.additions);
        if (additions.reduce((sum, a) => sum + BigInt(a.minor), BigInt(0)) > BigInt(refund.minor)) return fail();
      }
    }
    if (reserved > BigInt(observation.capturedMinor)) return fail();
  } catch { return fail(); }
}

const PRICING_BASES = ["final", "net"] as const;
/** A date, a time to the second or finer, and `Z` or an offset: an instant, never a local time. */
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const PRICING_TAX = ["none", "provider", "merchant-of-record"] as const;
const PRICING_PROMOTION_CODES = ["none", "provider"] as const;
const ADDITION_KINDS = ["tax", "shipping", "discount"] as const;
// Annotated so control flow treats a call as terminating; the narrowing below depends on it.
const invalid: () => never = () => { throw new PhisPaymentError("invalid_input"); };

function requireText(value: unknown, max = PHIS_PAYMENT_TEXT_LENGTH): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid();
}
/** Consumer input must spell exactly the contract's keys; a Provider's reported facts may carry more, and only the known ones are copied. */
function requireKeys(value: unknown, keys: readonly string[], exact = true): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const present = Object.keys(value as object);
  if (keys.some(k => !present.includes(k)) || (exact && present.some(k => !keys.includes(k)))) invalid();
}
function requireOneOf<T extends string>(value: unknown, choices: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !choices.includes(value as T)) invalid();
}
function requireList(value: unknown, max: number): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
}

export function validatePhisPaymentCustomerDetails(value: unknown, exact = true): PhisPaymentCustomerDetails | null {
  if (value === null) return null;
  requireKeys(value, ["country", "postalCode", "region", "addressSource", "taxIds"], exact);
  if (typeof value.country !== "string" || !/^[A-Z]{2}$/.test(value.country)) invalid();
  if (value.postalCode !== null) requireText(value.postalCode, 32);
  if (value.region !== null) requireText(value.region, 64);
  requireOneOf(value.addressSource, ["billing", "shipping"]);
  requireList(value.taxIds, PHIS_PAYMENT_MAX_TAX_IDS);
  const taxIds = value.taxIds.map(id => {
    requireKeys(id, ["type", "value"], exact); requireText(id.type, 32); requireText(id.value, 64);
    return { type: id.type, value: id.value };
  });
  return { country: value.country, postalCode: value.postalCode as string | null, region: value.region as string | null, addressSource: value.addressSource, taxIds };
}

/** Normalizes a consumer's pricing policy and checks that `amount` is exactly what its lines agree to. */
export function validatePhisPaymentPricing(value: unknown, amount: PhisPaymentMoney): PhisPaymentPricing {
  if (value && typeof value === "object" && !Array.isArray(value) && (value as { basis?: unknown }).basis === "final" && (value as { tax?: unknown }).tax === "none") {
    requireKeys(value, ["basis", "tax"]);
    return { basis: "final", tax: "none" };
  }
  requireKeys(value, ["basis", "tax", "lineItems", "shipping", "discounts", "promotionCodes", "customer"]);
  requireOneOf(value.basis, PRICING_BASES); requireOneOf(value.tax, PRICING_TAX); requireOneOf(value.promotionCodes, PRICING_PROMOTION_CODES);
  requireList(value.lineItems, PHIS_PAYMENT_MAX_LINE_ITEMS);
  if (value.lineItems.length === 0) invalid();
  const references = new Set<string>();
  let gross = BigInt(0);
  const lineItems = value.lineItems.map(line => {
    requireKeys(line, ["reference", "description", "quantity", "unitMinor", "taxCategory", "providerTaxCodes"]);
    requirePhisPaymentReference(line.reference); requireText(line.description); requirePhisPaymentMinor(line.unitMinor);
    requireOneOf(line.taxCategory, PHIS_PAYMENT_TAX_CATEGORIES);
    if (references.has(line.reference) || !Number.isInteger(line.quantity) || (line.quantity as number) < 1 || (line.quantity as number) > PHIS_PAYMENT_MAX_LINE_QUANTITY) invalid();
    references.add(line.reference);
    let providerTaxCodes: Record<string, string> | null = null;
    if (line.providerTaxCodes !== null) {
      if (!line.providerTaxCodes || typeof line.providerTaxCodes !== "object" || Array.isArray(line.providerTaxCodes)
        || Object.keys(line.providerTaxCodes).length > PHIS_PAYMENT_MAX_PROVIDER_TAX_CODES) invalid();
      providerTaxCodes = {};
      for (const [key, code] of Object.entries(line.providerTaxCodes)) { requirePhisPaymentReference(key); requirePhisPaymentReference(code); providerTaxCodes[key] = code; }
    }
    gross += BigInt(line.quantity as number) * BigInt(line.unitMinor);
    return { reference: line.reference, description: line.description, quantity: line.quantity as number, unitMinor: line.unitMinor, taxCategory: line.taxCategory, providerTaxCodes };
  });
  let shipping: { minor: string; taxCategory: "shipping" } | null = null;
  if (value.shipping !== null) {
    requireKeys(value.shipping, ["minor", "taxCategory"]); requirePhisPaymentMinor(value.shipping.minor);
    if (value.shipping.taxCategory !== "shipping") invalid();
    shipping = { minor: value.shipping.minor, taxCategory: "shipping" }; gross += BigInt(shipping.minor);
  }
  requireList(value.discounts, PHIS_PAYMENT_MAX_DISCOUNTS);
  const discountReferences = new Set<string>();
  let reductions = BigInt(0);
  const discounts = value.discounts.map(discount => {
    requireKeys(discount, ["reference", "label", "minor"]);
    requirePhisPaymentReference(discount.reference); requireText(discount.label); requirePhisPaymentMinor(discount.minor, true);
    if (discountReferences.has(discount.reference)) invalid();
    discountReferences.add(discount.reference); reductions += BigInt(discount.minor);
    return { reference: discount.reference, label: discount.label, minor: discount.minor };
  });
  requirePhisPaymentMinor(gross.toString());
  if (reductions > gross || (gross - reductions).toString() !== amount.minor) invalid();
  return { basis: value.basis, tax: value.tax, lineItems, shipping, discounts, promotionCodes: value.promotionCodes, customer: validatePhisPaymentCustomerDetails(value.customer) };
}

export function phisPaymentPricingSelector(pricing: PhisPaymentPricing): PhisPaymentPricingSelector {
  return "lineItems" in pricing
    ? { basis: pricing.basis, tax: pricing.tax, discounts: pricing.discounts.length, promotionCodes: pricing.promotionCodes }
    : { basis: "final", tax: "none", discounts: 0, promotionCodes: "none" };
}

export function validatePhisPaymentPricingSelector(value: unknown): PhisPaymentPricingSelector {
  requireKeys(value, ["basis", "tax", "discounts", "promotionCodes"]);
  requireOneOf(value.basis, PRICING_BASES); requireOneOf(value.tax, PRICING_TAX); requireOneOf(value.promotionCodes, PRICING_PROMOTION_CODES);
  if (!Number.isInteger(value.discounts) || (value.discounts as number) < 0 || (value.discounts as number) > PHIS_PAYMENT_MAX_DISCOUNTS) invalid();
  return { basis: value.basis, tax: value.tax, discounts: value.discounts as number, promotionCodes: value.promotionCodes };
}

export function phisPaymentMethodSupports(features: PhisPaymentPricingFeatures, selector: PhisPaymentPricingSelector): boolean {
  return features.bases.includes(selector.basis) && features.tax.includes(selector.tax) && selector.discounts <= features.maxDiscounts
    && (selector.promotionCodes === "none" || (features.promotionCodes !== "none" && (selector.discounts === 0 || features.promotionCodes === "with-discounts")));
}

/** The ends a method's checkout can be given: whole seconds, the earliest at least one, the latest within the longest Core accepts. */
function validateCheckoutExpiryFeatures(value: unknown): PhisPaymentCheckoutExpiryFeatures {
  requireKeys(value, ["minSeconds", "maxSeconds"], false);
  const { minSeconds, maxSeconds } = value;
  if (!Number.isInteger(minSeconds) || !Number.isInteger(maxSeconds) || (minSeconds as number) < 1 || (minSeconds as number) > (maxSeconds as number)
    || (maxSeconds as number) > PHIS_PAYMENT_MAX_CHECKOUT_EXPIRY_SECONDS) invalid();
  return { minSeconds: minSeconds as number, maxSeconds: maxSeconds as number };
}

/**
 * The instant a consumer wants the checkout to end by, as Core stores and sends it: an ISO 8601 date and
 * time with `Z` or an offset, normalized to UTC; `null` where none is stated. That it lies ahead, and
 * within what the method can keep (`checkoutExpiry`), is judged when a new payment is made.
 */
export function validatePhisPaymentExpiresAt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 40 || !ISO_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return new Date(value as string).toISOString();
}

function validateStoredFeatures(value: unknown): PhisPaymentStoredFeatures {
  requireKeys(value, ["setup", "chargeResult", "flags", "perPayer", "pricing"], false);
  requireList(value.setup, 2);
  for (const way of value.setup) requireOneOf(way, ["with-payment", "alone"]);
  requireOneOf(value.chargeResult, ["notified", "immediate"]); requireOneOf(value.perPayer, ["single", "many"]);
  if (value.setup.length === 0 || new Set(value.setup).size !== value.setup.length) invalid();
  return { setup: [...value.setup] as PhisPaymentStoredFeatures["setup"], chargeResult: value.chargeResult, flags: requireFlags(value.flags, PhisPaymentStoredFeatureFlag.Expires),
    perPayer: value.perPayer, pricing: validatePricingFeatures(value.pricing) };
}

const INTERVAL_UNITS = ["day", "week", "month", "year"] as const;
/** The units and the longest period a collection mode runs; `maxDays` within Core's own longest period. */
function validateIntervalFeatures(value: unknown): PhisPaymentIntervalFeatures {
  requireKeys(value, ["units", "maxDays"], false);
  requireList(value.units, INTERVAL_UNITS.length);
  for (const unit of value.units) requireOneOf(unit, INTERVAL_UNITS);
  if (value.units.length === 0 || new Set(value.units).size !== value.units.length
    || (value.maxDays !== null && (!Number.isInteger(value.maxDays) || (value.maxDays as number) < 1 || (value.maxDays as number) > 5 * 366))) invalid();
  return { units: [...value.units] as PhisPaymentIntervalFeatures["units"], maxDays: value.maxDays as number | null };
}

function validateScheduleFeatures(value: unknown): PhisPaymentScheduleFeatures {
  const interval = validateIntervalFeatures(value);
  requireKeys(value, ["units", "maxDays", "changes", "methodReplacement", "dunning", "flags"], false);
  requireKeys(value.changes, ["timings", "proration"], false);
  const changes = value.changes as { timings: unknown; proration: unknown };
  requireList(changes.timings, 2); requireList(changes.proration, 2);
  for (const timing of changes.timings) requireOneOf(timing, ["now", "period-end"]);
  for (const proration of changes.proration) requireOneOf(proration, ["time-share", "none"]);
  requireOneOf(value.methodReplacement, ["provider-page", "none"]);
  if (value.dunning !== "provider") invalid();
  return { ...interval, changes: { timings: [...changes.timings] as PhisPaymentScheduleFeatures["changes"]["timings"], proration: [...changes.proration] as PhisPaymentScheduleFeatures["changes"]["proration"] },
    methodReplacement: value.methodReplacement, dunning: "provider",
    flags: requireFlags(value.flags, PhisPaymentScheduleFeatureFlag.IntervalChange | PhisPaymentScheduleFeatureFlag.ChangedOutside) };
}

function validateCollectionFeatures(value: unknown): PhisPaymentCollectionFeatures {
  requireKeys(value, ["automatic", "paymentRequest", "providerManaged"], false);
  return {
    automatic: value.automatic === null ? null : validateIntervalFeatures(value.automatic),
    paymentRequest: value.paymentRequest === null ? null : validateIntervalFeatures(value.paymentRequest),
    providerManaged: value.providerManaged === null ? null : validateScheduleFeatures(value.providerManaged),
  };
}

function requireCurrencyCodes(value: unknown): string[] {
  requireList(value, 200);
  for (const code of value) if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) invalid();
  if (new Set(value).size !== value.length) invalid();
  return [...value] as string[];
}

function validateCurrencyFeatures(value: unknown): PhisPaymentCurrencyFeatures {
  requireKeys(value, ["amounts", "conversion", "conversionCurrencies", "conversionCost", "settlementCurrencies", "flags"], false);
  requireOneOf(value.amounts, ["single", "per-currency"]); requireOneOf(value.conversion, ["none", "optional", "mandatory"]);
  if (value.conversionCost !== null) requireOneOf(value.conversionCost, ["customer", "merchant"]);
  const conversionCurrencies = requireCurrencyCodes(value.conversionCurrencies);
  // Without a conversion there is nothing to offer it in and nobody to bear its cost.
  if (value.conversion === "none" && (conversionCurrencies.length > 0 || value.conversionCost !== null)) invalid();
  return { amounts: value.amounts, conversion: value.conversion, conversionCurrencies, conversionCost: value.conversionCost as PhisPaymentCurrencyFeatures["conversionCost"],
    settlementCurrencies: requireCurrencyCodes(value.settlementCurrencies), flags: requireFlags(value.flags, PhisPaymentCurrencyFeatureFlag.SettlementRecords) };
}

function validateDocumentFeatures(value: unknown): PhisPaymentDocumentFeatures {
  requireKeys(value, ["kinds", "issuer"], false);
  requireList(value.kinds, 3);
  const seen = new Set<string>();
  const kinds = value.kinds.map(entry => {
    requireKeys(entry, ["kind", "flags"], false);
    requireOneOf(entry.kind, ["invoice", "receipt", "credit-note"]);
    if (seen.has(entry.kind)) invalid();
    seen.add(entry.kind);
    return { kind: entry.kind, flags: requireFlags(entry.flags, PhisPaymentDocumentFeatureFlag.Fetchable | PhisPaymentDocumentFeatureFlag.Delayed) };
  });
  requireKeys(value.issuer, ["kind", "name", "taxId"], false);
  const issuer = value.issuer as Record<string, unknown>;
  requireOneOf(issuer.kind, ["merchant", "provider"]);
  if (issuer.name !== null) requireText(issuer.name);
  if (issuer.taxId !== null) requireText(issuer.taxId, 64);
  // The Provider issuing in its own name says who it is; only the merchant is named by the profile.
  if (issuer.kind === "provider" && issuer.name === null) invalid();
  return { kinds, issuer: { kind: issuer.kind, name: issuer.name as string | null, taxId: issuer.taxId as string | null } };
}

/** A flags number with no bit beyond `allowed`; another bit is a declaration Core does not understand. */
function requireFlags(value: unknown, allowed: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || ((value as number) & ~allowed) !== 0) invalid();
  return value as number;
}

/**
 * A stored method as a Provider reported it, copied field by field. The display is for a person and
 * must not carry what identifies the method elsewhere, so it is short text and nothing more is kept.
 */
export function validatePhisPaymentProviderStoredMethod(value: unknown): PhisPaymentProviderStoredMethod {
  try {
    requireKeys(value, ["binding", "display", "status", "expiresAt"], false);
    const binding = value.binding as PhisPaymentProviderStoredMethod["binding"];
    requirePhisPaymentReference(binding?.reference);
    if (!binding.data || Array.isArray(binding.data) || Object.keys(binding.data).length > 32) throw new Error();
    for (const [key, item] of Object.entries(binding.data)) { requirePhisPaymentReference(key); requirePhisPaymentReference(item); }
    const display = value.display as PhisPaymentProviderStoredMethod["display"];
    if (!display || typeof display.title !== "string" || display.title.length < 1 || display.title.length > 80
      || (display.hint !== null && (typeof display.hint !== "string" || display.hint.length < 1 || display.hint.length > 80))) throw new Error();
    requireOneOf(value.status, ["pending", "active", "invalid", "revoked", "expired"]);
    if (value.expiresAt !== null && (typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt)))) throw new Error();
    return { binding: { reference: binding.reference, data: { ...binding.data } }, display: { title: display.title, hint: display.hint },
      status: value.status, expiresAt: value.expiresAt === null ? null : new Date(value.expiresAt as string).toISOString() };
  } catch { throw new PhisPaymentError("provider_unavailable", "Provider returned an invalid stored method."); }
}

function validatePricingFeatures(value: unknown): PhisPaymentPricingFeatures {
  requireKeys(value, ["bases", "tax", "maxDiscounts", "promotionCodes", "flags"], false);
  requireList(value.bases, PRICING_BASES.length); requireList(value.tax, PRICING_TAX.length);
  for (const basis of value.bases) requireOneOf(basis, PRICING_BASES);
  for (const tax of value.tax) requireOneOf(tax, PRICING_TAX);
  if (!value.bases.includes("final") || !value.tax.includes("none") || new Set(value.bases).size !== value.bases.length || new Set(value.tax).size !== value.tax.length
    || !Number.isInteger(value.maxDiscounts) || (value.maxDiscounts as number) < 0 || (value.maxDiscounts as number) > PHIS_PAYMENT_MAX_DISCOUNTS) invalid();
  const flags = requireFlags(value.flags, PhisPaymentPricingFeatureFlag.CollectsCustomerDetails | PhisPaymentPricingFeatureFlag.CollectsTaxIds);
  requireOneOf(value.promotionCodes, ["none", "alone", "with-discounts"]);
  // Present exactly when the method sells as Merchant of Record: a consumer offers no more than it states.
  const merchantOfRecord = value.tax.includes("merchant-of-record")
    ? validateMerchantOfRecordFeatures(value.merchantOfRecord)
    : value.merchantOfRecord === null ? null : invalid();
  return { bases: [...value.bases] as PhisPaymentPricingFeatures["bases"], tax: [...value.tax] as PhisPaymentPricingFeatures["tax"], maxDiscounts: value.maxDiscounts as number,
    promotionCodes: value.promotionCodes, flags, merchantOfRecord };
}

/** Where and what a Provider sells as Merchant of Record: ISO countries, admitted categories, what a business's VAT id does. */
function validateMerchantOfRecordFeatures(value: unknown): PhisPaymentMerchantOfRecordFeatures {
  requireKeys(value, ["countries", "taxCategories", "businessTaxIds"], false);
  requireList(value.countries, 250); requireList(value.taxCategories, PHIS_PAYMENT_TAX_CATEGORIES.length); requireList(value.businessTaxIds, 2);
  for (const country of value.countries) if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)) invalid();
  for (const category of value.taxCategories) requireOneOf(category, PHIS_PAYMENT_TAX_CATEGORIES);
  for (const handling of value.businessTaxIds) requireOneOf(handling, ["charge", "reverse-charge"]);
  if (value.countries.length === 0 || value.taxCategories.length === 0 || value.businessTaxIds.length === 0
    || new Set(value.countries).size !== value.countries.length || new Set(value.taxCategories).size !== value.taxCategories.length
    || new Set(value.businessTaxIds).size !== value.businessTaxIds.length) invalid();
  return {
    countries: [...value.countries] as string[],
    taxCategories: [...value.taxCategories] as PhisPaymentMerchantOfRecordFeatures["taxCategories"],
    businessTaxIds: [...value.businessTaxIds] as PhisPaymentMerchantOfRecordFeatures["businessTaxIds"],
  };
}

function validateAddition(value: unknown): PhisPaymentAddition {
  requireKeys(value, ["kind", "minor", "label", "flags", "rate", "jurisdiction", "collectedBy", "code"], false);
  requireOneOf(value.kind, ADDITION_KINDS); requirePhisPaymentMinor(value.minor); requireText(value.label);
  requireOneOf(value.collectedBy, ["merchant", "provider"]);
  const flags = requireFlags(value.flags, PhisPaymentAdditionFlag.Inclusive);
  const inclusive = (flags & PhisPaymentAdditionFlag.Inclusive) !== 0;
  if ((value.rate !== null && (typeof value.rate !== "string" || !/^[0-9]{1,3}(\.[0-9]{1,4})?$/.test(value.rate)))
    || (value.jurisdiction !== null && (typeof value.jurisdiction !== "string" || !/^[A-Z]{2}(-[A-Z0-9]{1,8})?$/.test(value.jurisdiction)))) invalid();
  if (value.code !== null) requirePhisPaymentReference(value.code);
  if (value.kind === "discount" ? (inclusive || value.code === null) : value.code !== null) invalid();
  return { kind: value.kind, minor: value.minor, label: value.label, flags, rate: value.rate as string | null,
    jurisdiction: value.jurisdiction as string | null, collectedBy: value.collectedBy, code: value.code as string | null };
}

function validateAdditions(value: unknown): PhisPaymentAddition[] {
  requireList(value, PHIS_PAYMENT_MAX_ADDITIONS);
  return value.map(validateAddition);
}

/** A normalized copy of observed totals; the policy rules are checked by `validatePhisPaymentObservation`. */
export function normalizePhisPaymentTotals(value: PhisPaymentObservedTotals, frozenAt: string | null): PhisPaymentTotals {
  requireKeys(value, ["total", "additions", "customer", "presentment"], false);
  requireKeys(value.total, ["currency", "minor"], false); requirePhisPaymentMinor(value.total.minor);
  if (typeof value.total.currency !== "string") invalid();
  // What the customer saw in their own currency: informational, never part of a sum, never the payment's currency.
  let presentment: PhisPaymentMoney | null = null;
  if (value.presentment !== null) {
    requireKeys(value.presentment, ["currency", "minor"], false);
    validatePhisPaymentMoney(value.presentment, false);
    if (value.presentment.currency === value.total.currency) invalid();
    presentment = { currency: value.presentment.currency, minor: value.presentment.minor };
  }
  return { total: { currency: value.total.currency, minor: value.total.minor }, additions: validateAdditions(value.additions),
    customer: validatePhisPaymentCustomerDetails(value.customer, false), presentment, frozenAt };
}

export function copyPhisPaymentAdditions(value: readonly PhisPaymentAddition[] | null): PhisPaymentAddition[] | null {
  return value === null ? null : validateAdditions(value);
}

/** Returns the amount the customer owes: the validated total, or the base amount while no total is known. */
function validateObservedTotals(previous: PhisPayment, observation: PhisPaymentProviderObservation): bigint {
  const settled = observation.status === "authorized" || observation.status === "captured";
  if (observation.totals === null) {
    if (settled || previous.totals?.frozenAt) invalid();
    return BigInt(previous.amount.minor);
  }
  const totals = normalizePhisPaymentTotals(observation.totals, null);
  if (totals.total.currency !== previous.amount.currency) invalid();
  const base = BigInt(previous.amount.minor);
  const pricing = previous.pricing;
  if (!("lineItems" in pricing)) {
    if (totals.additions.length > 0 || totals.total.minor !== previous.amount.minor) invalid();
  } else {
    const stated = new Map(pricing.discounts.map(d => [d.reference, d.minor]));
    const seen = new Set<string>();
    let exclusiveTax = BigInt(0); let inclusive = BigInt(0); let providerDiscounts = BigInt(0); let discounts = BigInt(0); let shipping = 0;
    for (const addition of totals.additions) {
      if (addition.kind === "tax") {
        const inclusiveTax = (addition.flags & PhisPaymentAdditionFlag.Inclusive) !== 0;
        if (pricing.tax === "none" || inclusiveTax !== (pricing.basis === "final")
          || addition.collectedBy !== (pricing.tax === "merchant-of-record" ? "provider" : "merchant")) invalid();
        if (inclusiveTax) inclusive += BigInt(addition.minor); else exclusiveTax += BigInt(addition.minor);
      } else if (addition.kind === "shipping") {
        if ((addition.flags & PhisPaymentAdditionFlag.Inclusive) === 0 || addition.collectedBy !== "merchant" || pricing.shipping === null || addition.minor !== pricing.shipping.minor || shipping++ > 0) invalid();
      } else {
        if (addition.collectedBy !== "merchant") invalid();
        const expected = stated.get(addition.code!);
        if (expected !== undefined) { if (seen.has(addition.code!) || expected !== addition.minor) invalid(); seen.add(addition.code!); }
        else { if (pricing.promotionCodes !== "provider") invalid(); providerDiscounts += BigInt(addition.minor); }
        discounts += BigInt(addition.minor);
      }
    }
    if (seen.size !== stated.size) invalid();
    const gross = pricing.lineItems.reduce((sum, l) => sum + BigInt(l.quantity) * BigInt(l.unitMinor), BigInt(0)) + BigInt(pricing.shipping?.minor ?? "0");
    if (discounts > gross || providerDiscounts > base + exclusiveTax) invalid();
    if ((base + exclusiveTax - providerDiscounts).toString() !== totals.total.minor || inclusive > BigInt(totals.total.minor)) invalid();
  }
  if (previous.totals?.frozenAt) {
    const { frozenAt: _frozenAt, ...frozen } = previous.totals;
    // `presentment` is informational and may arrive after the total became binding; the binding parts may not move.
    const { presentment: _presentment, ...binding } = frozen;
    if (!isDeepStrictEqual(binding, { total: totals.total, additions: totals.additions, customer: totals.customer })) invalid();
  }
  return BigInt(totals.total.minor);
}
