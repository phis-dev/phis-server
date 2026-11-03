import { isDeepStrictEqual } from "node:util";
import type {
  PhisPayment, PhisPaymentAddition, PhisPaymentCustomerDetails, PhisPaymentErrorCode, PhisPaymentMoney, PhisPaymentObservedTotals,
  PhisPaymentPricing, PhisPaymentPricingFeatures, PhisPaymentPricingSelector, PhisPaymentProfileDraft, PhisPaymentProviderObservation,
  PhisPaymentProviderProbe, PhisPaymentTotals,
} from "@phis/contracts/payments";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import {
  PHIS_PAYMENT_CURRENCY_EXPONENTS, PHIS_PAYMENT_MAX_ADDITIONS, PHIS_PAYMENT_MAX_DISCOUNTS, PHIS_PAYMENT_MAX_LINE_ITEMS,
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
        || features.checkoutKinds.some((k: string) => k !== "redirect" && k !== "provider-ui")
        || ["canPartialCapture", "canCancel", "canRefund", "canPartialRefund"].some(k => typeof features[k as keyof typeof features] !== "boolean")) throw new Error();
      keys.add(method.methodKey);
      return { methodKey: method.methodKey, title: method.title, features: {
        captureModes: [...features.captureModes], checkoutKinds: [...features.checkoutKinds], canPartialCapture: features.canPartialCapture,
        canCancel: features.canCancel, canRefund: features.canRefund, canPartialRefund: features.canPartialRefund,
        pricing: validatePricingFeatures(features.pricing),
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
      || grant.operations.some((op: string) => !["read", "create", "complete", "refresh", "capture", "cancel", "refund"].includes(op))
      || !grant.merchantActions || Object.keys(grant.merchantActions).some(k => !["capture", "cancel", "refund"].includes(k))) return fail();
    owners.add(grant.consumerAddonId);
    for (const action of ["capture", "cancel", "refund"] as const) {
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

function validatePricingFeatures(value: unknown): PhisPaymentPricingFeatures {
  requireKeys(value, ["bases", "tax", "maxDiscounts", "promotionCodes", "collectsCustomerDetails", "collectsTaxIds"], false);
  requireList(value.bases, PRICING_BASES.length); requireList(value.tax, PRICING_TAX.length);
  for (const basis of value.bases) requireOneOf(basis, PRICING_BASES);
  for (const tax of value.tax) requireOneOf(tax, PRICING_TAX);
  if (!value.bases.includes("final") || !value.tax.includes("none") || new Set(value.bases).size !== value.bases.length || new Set(value.tax).size !== value.tax.length
    || !Number.isInteger(value.maxDiscounts) || (value.maxDiscounts as number) < 0 || (value.maxDiscounts as number) > PHIS_PAYMENT_MAX_DISCOUNTS
    || typeof value.collectsCustomerDetails !== "boolean" || typeof value.collectsTaxIds !== "boolean") invalid();
  requireOneOf(value.promotionCodes, ["none", "alone", "with-discounts"]);
  return { bases: [...value.bases] as PhisPaymentPricingFeatures["bases"], tax: [...value.tax] as PhisPaymentPricingFeatures["tax"], maxDiscounts: value.maxDiscounts as number,
    promotionCodes: value.promotionCodes, collectsCustomerDetails: value.collectsCustomerDetails, collectsTaxIds: value.collectsTaxIds };
}

function validateAddition(value: unknown): PhisPaymentAddition {
  requireKeys(value, ["kind", "minor", "label", "inclusive", "rate", "jurisdiction", "collectedBy", "code"], false);
  requireOneOf(value.kind, ADDITION_KINDS); requirePhisPaymentMinor(value.minor); requireText(value.label);
  requireOneOf(value.collectedBy, ["merchant", "provider"]);
  if (typeof value.inclusive !== "boolean" || (value.rate !== null && (typeof value.rate !== "string" || !/^[0-9]{1,3}(\.[0-9]{1,4})?$/.test(value.rate)))
    || (value.jurisdiction !== null && (typeof value.jurisdiction !== "string" || !/^[A-Z]{2}(-[A-Z0-9]{1,8})?$/.test(value.jurisdiction)))) invalid();
  if (value.code !== null) requirePhisPaymentReference(value.code);
  if (value.kind === "discount" ? (value.inclusive || value.code === null) : value.code !== null) invalid();
  return { kind: value.kind, minor: value.minor, label: value.label, inclusive: value.inclusive, rate: value.rate as string | null,
    jurisdiction: value.jurisdiction as string | null, collectedBy: value.collectedBy, code: value.code as string | null };
}

function validateAdditions(value: unknown): PhisPaymentAddition[] {
  requireList(value, PHIS_PAYMENT_MAX_ADDITIONS);
  return value.map(validateAddition);
}

/** A normalized copy of observed totals; the policy rules are checked by `validatePhisPaymentObservation`. */
export function normalizePhisPaymentTotals(value: PhisPaymentObservedTotals, frozenAt: string | null): PhisPaymentTotals {
  requireKeys(value, ["total", "additions", "customer"], false);
  requireKeys(value.total, ["currency", "minor"], false); requirePhisPaymentMinor(value.total.minor);
  if (typeof value.total.currency !== "string") invalid();
  return { total: { currency: value.total.currency, minor: value.total.minor }, additions: validateAdditions(value.additions), customer: validatePhisPaymentCustomerDetails(value.customer, false), frozenAt };
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
        if (pricing.tax === "none" || addition.inclusive !== (pricing.basis === "final")
          || addition.collectedBy !== (pricing.tax === "merchant-of-record" ? "provider" : "merchant")) invalid();
        if (addition.inclusive) inclusive += BigInt(addition.minor); else exclusiveTax += BigInt(addition.minor);
      } else if (addition.kind === "shipping") {
        if (!addition.inclusive || addition.collectedBy !== "merchant" || pricing.shipping === null || addition.minor !== pricing.shipping.minor || shipping++ > 0) invalid();
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
    if (!isDeepStrictEqual(frozen, { total: totals.total, additions: totals.additions, customer: totals.customer })) invalid();
  }
  return BigInt(totals.total.minor);
}
