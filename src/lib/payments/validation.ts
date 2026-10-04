import type {
  PhisPaymentErrorCode, PhisPaymentMoney, PhisPaymentProfileDraft, PhisPaymentProviderObservation,
  PhisPaymentProviderProbe,
} from "@phis/contracts/payments";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import { PHIS_PAYMENT_CURRENCY_EXPONENTS, PHIS_PAYMENT_MAX_REFUNDS } from "../constants/payments.ts";
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
    if (BigInt(observation.capturedMinor) > BigInt(previous.amount.minor) || BigInt(observation.authorizedMinor) > BigInt(previous.amount.minor)
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
    }
    if (reserved > BigInt(observation.capturedMinor)) return fail();
  } catch { return fail(); }
}
