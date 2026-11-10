import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type {
  PhisPaymentCheckoutPlan, PhisPaymentCommandResult, PhisPaymentCreateInput, PhisPaymentErrorCode, PhisPaymentGrantedOperation, PhisPaymentMerchantActionPolicy, PhisPaymentMoney,
  PhisPaymentPricing, PhisPaymentProviderExecution, PhisPaymentProviderObservation, PhisPaymentProviderStoredMethod, PhisPaymentProviderV1,
  PhisPaymentStoredMethod, PhisPaymentSubscription, PhisPaymentSubscriptionCreateInput, PhisPaymentSubscriptionPeriod, PhisPaymentSubscriptionResult,
  PhisPaymentSubscriptionTerms, PhisPaymentsCapabilityV1,
} from "@phis/contracts/payments";
import {
  ensurePhisPaymentSubscriptionPeriod, findPhisPaymentSubscriptionIdempotency, insertPhisPaymentSubscription, isPhisPaymentStoredMethodInUse,
  listPhisPaymentSubscriptionPeriods, listPhisPaymentSubscriptionsOnMethod, postponePhisPaymentSubscription, readPhisPaymentSubscription,
  readPhisPaymentSubscriptionPeriod, writePhisPaymentSubscription, writePhisPaymentSubscriptionPeriod,
} from "../../db/payment-subscriptions.mts";
import {
  addPhisPaymentIntervals, nextPhisPaymentDunningAttempt, phisPaymentDunningDeadline, validatePhisPaymentDunningPolicy, validatePhisPaymentInterval,
} from "./schedule.ts";
import {
  claimPhisPayment, findPhisPaymentIdempotency, insertPhisPayment, insertPhisPaymentOperation,
  listPhisPaymentOperations, listPhisPaymentRefunds, readPhisPayment, readPhisPaymentOperation, readPhisPaymentProfile,
  readPhisPaymentRefund, writePhisPayment, writePhisPaymentOperation, writePhisPaymentRefund, finishPhisPaymentReceipt,
  findPhisPaymentStoredMethodSetup, insertPhisPaymentStoredMethod, listPhisPaymentStoredMethods, readPhisPaymentStoredMethod,
  revokeSupersededPhisPaymentStoredMethods, writePhisPaymentStoredMethod, writePhisPaymentStoredMethodSetupCheckout,
} from "../../db/payments.mts";
import { withPoolTransaction } from "../db-transaction.ts";
import { PHIS_PAYMENT_CALL_TIMEOUT_MS, PHIS_PAYMENT_ERROR_CODES } from "../constants/payments.ts";
import { PhisPaymentError, copyPhisPaymentAdditions, normalizePhisPaymentTotals, phisPaymentMethodSupports, phisPaymentPricingSelector,
  phisPaymentReturnUrl, requirePhisPaymentMinor, requirePhisPaymentReference, validatePhisPaymentMoney, validatePhisPaymentObservation,
  validatePhisPaymentPricing, validatePhisPaymentPricingSelector, validatePhisPaymentProviderProbe, validatePhisPaymentProviderStoredMethod } from "./validation.ts";
import type {
  PhisPaymentProfile, PhisPaymentReceipt, PhisPaymentScope, PhisStoredPayment, PhisStoredPaymentCommand, PhisStoredPaymentMethod,
  PhisStoredPaymentOperation, PhisStoredPaymentRefund, PhisStoredPaymentSubscription,
} from "./types.ts";

type Action = PhisStoredPaymentOperation["record"]["action"];
/** What a consumer commands on an existing payment. `create` and `charge` bring one into being instead. */
type MutationAction = Exclude<Action, "create" | "charge">;
/** The grant an operation is resumed under: a charge is Core's own act, so reading it is what is asked. */
const grantedFor = (action: Action): PhisPaymentGrantedOperation => action === "charge" ? "read" : action;
type MutationInput = { paymentId: string; idempotencyKey: string; minor?: string; reason?: string };
/** The period of a subscription a payment settles; Core's own knowledge, never a consumer's argument. */
type PeriodLink = { subscriptionId: string; periodIndex: number };
const ENDED_PAYMENT = ["failed", "expired", "canceled"];
type Options = {
  pool: Pool;
  scope: PhisPaymentScope;
  signal: AbortSignal;
  publicBaseUrl: () => Promise<string>;
  resolveProvider: (profile: PhisPaymentProfile) => Promise<PhisPaymentProviderV1>;
  merchantAuthorized: (action: "capture" | "cancel" | "refund" | "subscriptionEnd" | "subscriptionPrice", policy: PhisPaymentMerchantActionPolicy) => Promise<boolean>;
  unauthenticated?: boolean;
  afterCommit?: () => Promise<unknown>;
  /**
   * Told what a Provider threw. The engine itself answers `provider_unavailable` or an unknown outcome,
   * which is right for the caller and said nothing to the operator; whoever constructs the engine
   * writes the failure where it logs. Not the engine, because the CLI loads this module too and the
   * server's log is `server-only`.
   */
  providerFailed?: (failure: PhisPaymentProviderFailure) => void;
};

export type PhisPaymentProviderFailure = {
  call: "probe" | "execute" | "recover" | "reconcile" | "revoke";
  error: unknown;
  meta: { siteId: number; consumerAddonId: string; profileKey: string; paymentId?: string; operationId?: string | null };
};

/** No transaction spans an external request. A fenced lease serializes observations and commands. */
export class PhisPaymentEngine implements PhisPaymentsCapabilityV1 {
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }
  private get pool() { return this.options.pool; }
  private get scope() { return this.options.scope; }
  private signal() { return AbortSignal.any([this.options.signal, AbortSignal.timeout(PHIS_PAYMENT_CALL_TIMEOUT_MS)]); }

  private async profile(key: string, operation: PhisPaymentGrantedOperation, creating = false): Promise<PhisPaymentProfile> {
    if (this.options.unauthenticated) throw new PhisPaymentError("forbidden");
    const profile = await readPhisPaymentProfile(this.pool, this.scope.siteId, key);
    const grant = profile?.grants.find(g => g.consumerAddonId === this.scope.consumerAddonId);
    if (!profile || !grant?.operations.includes(operation)) throw new PhisPaymentError("not_found");
    if (creating && (!profile.enabled || profile.retired || !profile.probedAt || !profile.merchantIdentity)) throw new PhisPaymentError("profile_unavailable");
    if (operation === "capture" || operation === "cancel" || operation === "refund") {
      if (!await this.options.merchantAuthorized(operation, grant.merchantActions[operation])) throw new PhisPaymentError("forbidden");
    }
    return profile;
  }

  private providerFailed(
    call: PhisPaymentProviderFailure["call"],
    error: unknown,
    meta: Omit<PhisPaymentProviderFailure["meta"], "siteId" | "consumerAddonId">,
  ) {
    this.options.providerFailed?.({
      call,
      error,
      meta: { siteId: this.scope.siteId, consumerAddonId: this.scope.consumerAddonId, ...meta },
    });
  }

  private async persisted(id: string, operation: PhisPaymentGrantedOperation): Promise<{ payment: PhisStoredPayment; profile: PhisPaymentProfile } | null> {
    requirePhisPaymentReference(id);
    const payment = await readPhisPayment(this.pool, this.scope.siteId, id, this.scope.consumerAddonId);
    if (!payment) return null;
    try { return { payment, profile: await this.profile(payment.record.profileKey, operation) }; }
    catch (error) { if (error instanceof PhisPaymentError && error.code === "not_found") return null; throw error; }
  }

  async get(paymentId: string) { return (await this.persisted(paymentId, "read"))?.payment.record ?? null; }
  async getOperation(id: string) {
    requirePhisPaymentReference(id);
    const operation = await readPhisPaymentOperation(this.pool, id, this.scope);
    return operation && await this.persisted(operation.record.paymentId, "read") ? operation.record : null;
  }
  async getRefund(id: string) {
    requirePhisPaymentReference(id);
    const refund = await readPhisPaymentRefund(this.pool, id, this.scope);
    return refund && await this.persisted(refund.record.paymentId, "read") ? refund.record : null;
  }

  /** A stored method the consumer owns and may read; `null` for one it does not, as for a payment. */
  private async storedMethod(id: string, operation: PhisPaymentGrantedOperation): Promise<{ method: PhisStoredPaymentMethod; profile: PhisPaymentProfile } | null> {
    requirePhisPaymentReference(id);
    const method = await readPhisPaymentStoredMethod(this.pool, this.scope.siteId, id, this.scope.consumerAddonId);
    if (!method) return null;
    try { return { method, profile: await this.profile(method.record.profileKey, operation) }; }
    catch (error) { if (error instanceof PhisPaymentError && error.code === "not_found") return null; throw error; }
  }

  async getStoredMethod(storedMethodId: string): Promise<PhisPaymentStoredMethod | null> {
    return (await this.storedMethod(storedMethodId, "method-read"))?.method.record ?? null;
  }

  async listStoredMethods(input: Parameters<PhisPaymentsCapabilityV1["listStoredMethods"]>[0]): Promise<readonly PhisPaymentStoredMethod[]> {
    requirePhisPaymentReference(input.profileKey); requirePhisPaymentReference(input.payerReference);
    await this.profile(input.profileKey, "method-read");
    return (await listPhisPaymentStoredMethods(this.pool, this.scope, input.profileKey, input.payerReference)).map(method => method.record);
  }

  /**
   * Revokes at the Provider first and records it second. A record that said "revoked" while the Provider
   * still held the method would be the dangerous way round: the payer would believe it gone.
   */
  async removeStoredMethod(storedMethodId: string): Promise<PhisPaymentStoredMethod | null> {
    const found = await this.storedMethod(storedMethodId, "method-remove");
    if (!found) return null;
    const { method, profile } = found;
    if (method.record.status !== "pending" && method.record.status !== "active") return method.record;
    // A subscription charged to it would fail at its next renewal; it is given another method first.
    if (await isPhisPaymentStoredMethodInUse(this.pool, method.record.id)) throw new PhisPaymentError("invalid_state");
    if (method.binding) {
      let outcome: "revoked" | "unknown";
      try {
        const provider = await this.options.resolveProvider(profile);
        if (!provider.revokeStoredMethod) throw new PhisPaymentError("unsupported_operation");
        // db-boundary-exempt: the Provider executes a PSP HTTP command and receives no database handle.
        outcome = (await provider.revokeStoredMethod({ binding: method.binding, signal: this.signal() }))?.outcome;
      } catch (error) {
        if (error instanceof PhisPaymentError) throw error;
        this.providerFailed("revoke", error, { profileKey: profile.key });
        throw new PhisPaymentError("provider_unavailable");
      }
      if (outcome !== "revoked") throw new PhisPaymentError("provider_unavailable");
    }
    return withPoolTransaction(this.pool, async db => {
      const current = (await readPhisPaymentStoredMethod(db, this.scope.siteId, storedMethodId, this.scope.consumerAddonId, true))!;
      if (current.record.status === "pending" || current.record.status === "active") {
        current.record.status = "revoked"; current.record.version += 1;
        await writePhisPaymentStoredMethod(db, current);
      }
      return current.record;
    });
  }

  /**
   * Stores a method without a payment: the Provider opens a hosted page, the customer enters the method
   * there, and nothing is charged.
   *
   * The record exists from the first answer on, `pending`, so the consumer can name it; it becomes
   * `active` when the Provider says the method exists, and `invalid` when no page could be opened or the
   * customer never finished. Idempotent on the consumer's key: the same request is answered with the
   * same record and the same page.
   */
  async setupMethod(input: Parameters<PhisPaymentsCapabilityV1["setupMethod"]>[0]): ReturnType<PhisPaymentsCapabilityV1["setupMethod"]> {
    input = structuredClone(input);
    requirePhisPaymentReference(input.profileKey); requirePhisPaymentReference(input.idempotencyKey); requirePhisPaymentReference(input.payerReference);
    validatePhisPaymentMoney(input.amount);
    this.validateFlow("automatic", input.checkoutKind);
    if (input.methodKey !== null && (typeof input.methodKey !== "string" || input.methodKey.length > 255)) throw new PhisPaymentError("invalid_input");
    const profile = await this.profile(input.profileKey, "method-store");
    const replay = (found: { method: PhisStoredPaymentMethod; checkout: unknown }) => {
      const same = found.method.record.payerReference === input.payerReference && found.method.record.profileKey === input.profileKey
        && found.method.record.methodKey === input.methodKey;
      if (!same) throw new PhisPaymentError("idempotency_conflict");
      return { storedMethod: found.method.record, checkout: found.method.record.status === "pending" ? (found.checkout as PhisPaymentCheckoutPlan | null) : null };
    };
    const previous = await withPoolTransaction(this.pool, db => findPhisPaymentStoredMethodSetup(db, this.scope, input.idempotencyKey));
    if (previous) return replay(previous);
    if (!profile.enabled || profile.retired || !profile.probedAt || !profile.merchantIdentity) throw new PhisPaymentError("profile_unavailable");
    const baseUrl = await this.options.publicBaseUrl();
    const available = await this.methods(profile, { amount: { currency: input.amount.currency, minor: input.amount.minor }, captureMode: "automatic",
      checkoutKind: input.checkoutKind, pricing: { basis: "final", tax: "none", discounts: 0, promotionCodes: "none" }, usage: "recurring" });
    const offered = available.find(m => m.methodKey === input.methodKey);
    if (!offered) throw new PhisPaymentError("method_unavailable");
    if (!offered.features.stored?.setup.includes("alone")) throw new PhisPaymentError("unsupported_operation");
    const provider = await this.options.resolveProvider(profile);
    if (!provider.setupStoredMethod) throw new PhisPaymentError("unsupported_operation");

    const id = randomUUID();
    const returnUrl = new URL(phisPaymentReturnUrl(baseUrl, input.returnPath, id));
    // The helper names what returns a payment; here it is a stored method that returns.
    returnUrl.searchParams.delete("paymentId"); returnUrl.searchParams.set("storedMethodId", id);
    const providerId = profile.providerAddonId.slice(1).split("/").map(encodeURIComponent).join("/");
    const notificationUrl = new URL(`/api/hooks/${providerId}/payments/${encodeURIComponent(profile.key)}`, baseUrl).href;
    const method: PhisStoredPaymentMethod = {
      siteId: this.scope.siteId, consumerAddonId: this.scope.consumerAddonId, features: offered.features, binding: null,
      record: { id, profileKey: profile.key, mode: profile.mode, payerReference: input.payerReference, methodKey: offered.methodKey,
        display: { title: offered.title.slice(0, 80), hint: null }, status: "pending", expiresAt: null, version: 1 },
    };
    const raced = await withPoolTransaction(this.pool, async db => {
      const found = await findPhisPaymentStoredMethodSetup(db, this.scope, input.idempotencyKey);
      if (found) return found;
      await this.checkProfileRevision(db, profile, "method-store");
      await insertPhisPaymentStoredMethod(db, method, input.idempotencyKey);
      return null;
    });
    if (raced) return replay(raced);

    let opened: Awaited<ReturnType<NonNullable<PhisPaymentProviderV1["setupStoredMethod"]>>>;
    try {
      // db-boundary-exempt: the Provider executes a PSP HTTP command and receives no database handle.
      opened = await provider.setupStoredMethod({ storedMethodId: id, providerIdempotencyKey: id, payerReference: input.payerReference, methodKey: offered.methodKey,
        returnUrl: returnUrl.href, notificationUrl, signal: this.signal() });
    } catch (error) {
      this.providerFailed("execute", error, { profileKey: profile.key });
      opened = { outcome: "unknown" };
    }
    let checkout: PhisPaymentCheckoutPlan | null = null;
    if (opened?.outcome === "applied") {
      try {
        requirePhisPaymentReference(opened.binding?.reference);
        if (opened.checkout?.kind !== "redirect" || new URL(opened.checkout.url).protocol !== "https:") throw new Error();
        checkout = { kind: "redirect", url: new URL(opened.checkout.url).href, expiresAt: opened.checkout.expiresAt ?? null };
      } catch { checkout = null; }
    }
    const binding = checkout && opened?.outcome === "applied" ? { reference: opened.binding.reference, data: { ...opened.binding.data } } : null;
    const record = await withPoolTransaction(this.pool, async db => {
      const current = (await readPhisPaymentStoredMethod(db, this.scope.siteId, id, this.scope.consumerAddonId, true))!;
      // No page anybody can be sent to: the record ends here instead of waiting for a customer who cannot come.
      if (binding) current.binding = binding; else current.record.status = "invalid";
      current.record.version += 1;
      await writePhisPaymentStoredMethod(db, current);
      if (checkout) await writePhisPaymentStoredMethodSetupCheckout(db, id, checkout);
      return current.record;
    });
    if (!checkout) throw new PhisPaymentError(opened?.outcome === "rejected" && PHIS_PAYMENT_ERROR_CODES.includes(opened.code) ? opened.code : "provider_unavailable");
    return { storedMethod: record, checkout };
  }

  /** How the stored method stands at the Provider now: what a customer who has just returned is shown. */
  async refreshStoredMethod(storedMethodId: string): Promise<PhisPaymentStoredMethod | null> {
    const found = await this.storedMethod(storedMethodId, "method-read");
    if (!found) return null;
    const { method } = found;
    // Asked only while there is something to learn; a method that has ended stays as it is.
    if (method.binding && (method.record.status === "pending" || method.record.status === "active")) {
      await this.reconcileStoredMethod(method, found.profile).catch(() => {});
    }
    return (await readPhisPaymentStoredMethod(this.pool, this.scope.siteId, storedMethodId, this.scope.consumerAddonId))!.record;
  }

  /**
   * What every period from the next one on costs. The agreement changes and nothing else does: a period
   * already created keeps the amount it was created with, and nothing is prorated or refunded.
   */
  async changeSubscriptionPrice(input: Parameters<PhisPaymentsCapabilityV1["changeSubscriptionPrice"]>[0]): Promise<PhisPaymentSubscription | null> {
    const recurring = this.validateTerms(input.recurring);
    const found = await this.subscription(input.subscriptionId, "subscription-create");
    if (!found) return null;
    const grant = found.profile.grants.find(g => g.consumerAddonId === this.scope.consumerAddonId)!;
    const policy = grant.merchantActions.subscriptionPrice;
    if (!policy || !await this.options.merchantAuthorized("subscriptionPrice", policy)) throw new PhisPaymentError("forbidden");
    const record = await withPoolTransaction(this.pool, async db => {
      const current = (await readPhisPaymentSubscription(db, this.scope.siteId, input.subscriptionId, this.scope.consumerAddonId, true))!;
      if (current.record.status === "canceled" || current.record.status === "pending") throw new PhisPaymentError("invalid_state");
      if (current.record.recurring.amount.currency !== recurring.amount.currency) throw new PhisPaymentError("invalid_input");
      // What the stored method was stored to carry still bounds what it can be charged.
      const method = current.record.storedMethodId ? await readPhisPaymentStoredMethod(db, this.scope.siteId, current.record.storedMethodId, this.scope.consumerAddonId) : null;
      if (method && (!method.features.stored || !phisPaymentMethodSupports(method.features.stored.pricing, phisPaymentPricingSelector(recurring.pricing)))) throw new PhisPaymentError("unsupported_operation");
      if (isDeepStrictEqual(current.record.recurring, recurring)) return current.record;
      current.record.recurring = recurring; current.record.version += 1;
      await writePhisPaymentSubscription(db, current, null);
      return current.record;
    });
    await this.options.afterCommit?.().catch(() => {});
    return record;
  }

  /** What the Provider says about a stored method now; used by the verified notification ingress. */
  async reconcileStoredMethod(method: PhisStoredPaymentMethod, profile: PhisPaymentProfile) {
    if (!method.binding) return;
    let reported: PhisPaymentProviderStoredMethod;
    try {
      const provider = await this.options.resolveProvider(profile);
      if (!provider.observeStoredMethod) throw new PhisPaymentError("unsupported_operation");
      reported = validatePhisPaymentProviderStoredMethod(await provider.observeStoredMethod({ binding: method.binding, signal: this.signal() }));
    } catch (error) {
      if (!(error instanceof PhisPaymentError)) this.providerFailed("reconcile", error, { profileKey: profile.key });
      throw new PhisPaymentError("provider_unavailable");
    }
    await withPoolTransaction(this.pool, db => this.writeReportedStoredMethod(db, method.siteId, method.record.id, reported));
  }

  /**
   * Takes what a Provider reported into the record. A method that has ended stays ended: a late report
   * that it is active must not bring back what the payer or the merchant removed.
   */
  private async writeReportedStoredMethod(db: PoolClient, siteId: number, id: string, reported: PhisPaymentProviderStoredMethod): Promise<boolean> {
    const method = await readPhisPaymentStoredMethod(db, siteId, id, null, true);
    if (!method) return false;
    // A set-up that is still open has nothing to report yet.
    if (reported.status === "pending") return false;
    // While pending, the binding is the hosted page's; the method's own takes its place once it exists.
    if (method.binding && method.record.status !== "pending" && method.binding.reference !== reported.binding.reference) throw new PhisPaymentError("provider_unavailable");
    const ended = method.record.status !== "pending" && method.record.status !== "active";
    if (ended && reported.status === "active") return false;
    const before = structuredClone({ record: method.record, binding: method.binding });
    method.binding = reported.binding;
    Object.assign(method.record, { display: reported.display, status: reported.status, expiresAt: reported.expiresAt });
    if (isDeepStrictEqual(before, { record: method.record, binding: method.binding })) return false;
    method.record.version += 1;
    await writePhisPaymentStoredMethod(db, method);
    if (method.record.status === "active" && before.record.status !== "active" && method.features.stored?.perPayer === "single") {
      // The Provider holds one method for this payer and it is now this one; what was charged to the
      // others is charged to it from here on.
      for (const superseded of await revokeSupersededPhisPaymentStoredMethods(db, method)) {
        for (const subscription of await listPhisPaymentSubscriptionsOnMethod(db, superseded)) {
          subscription.record.storedMethodId = method.record.id; subscription.record.version += 1;
          await writePhisPaymentSubscription(db, subscription, null);
        }
      }
    }
    return true;
  }

  /**
   * What a payment's outcome means for the stored method it belongs to.
   *
   * A customer's payment creates the method: it becomes what the Provider reports, or `invalid` when the
   * payment ended without the Provider ever having one. A charge only ever ends a method, and only on
   * the Provider's word that it is gone.
   */
  private async settleStoredMethod(db: PoolClient, payment: PhisStoredPayment, reported: PhisPaymentProviderStoredMethod | null, rejected: PhisPaymentErrorCode | null): Promise<boolean> {
    const id = payment.record.storedMethodId;
    if (!id) return false;
    if (payment.record.initiator === "customer" && reported) return this.writeReportedStoredMethod(db, payment.siteId, id, reported);
    const method = await readPhisPaymentStoredMethod(db, payment.siteId, id, null, true);
    if (!method) return false;
    const neverStored = payment.record.initiator === "customer" && method.record.status === "pending"
      && ["failed", "expired", "canceled"].includes(payment.record.status);
    const gone = payment.record.initiator !== "customer" && rejected === "stored_method_unavailable" && method.record.status === "active";
    if (!neverStored && !gone) return false;
    method.record.status = "invalid"; method.record.version += 1;
    await writePhisPaymentStoredMethod(db, method);
    return true;
  }

  async listMethods(input: Parameters<PhisPaymentsCapabilityV1["listMethods"]>[0]) {
    input = structuredClone(input);
    if (input.usage !== undefined && input.usage !== "one-time" && input.usage !== "recurring") throw new PhisPaymentError("invalid_input");
    validatePhisPaymentMoney(input.amount);
    this.validateFlow(input.captureMode, input.checkoutKind);
    const pricing = validatePhisPaymentPricingSelector(input.pricing);
    const profile = await this.profile(input.profileKey, "read", true);
    return this.methods(profile, { amount: { currency: input.amount.currency, minor: input.amount.minor }, captureMode: input.captureMode, checkoutKind: input.checkoutKind, pricing,
      ...(input.usage === "recurring" ? { usage: "recurring" as const } : {}) });
  }
  private validateFlow(captureMode: string, checkoutKind: string) {
    if (!["automatic", "manual"].includes(captureMode) || checkoutKind !== "redirect") throw new PhisPaymentError("unsupported_operation");
  }
  private async methods(profile: PhisPaymentProfile, input: Omit<Parameters<PhisPaymentProviderV1["probe"]>[0], "signal">) {
    let probe;
    try {
      const provider = await this.options.resolveProvider(profile);
      probe = await provider.probe({ ...input, signal: this.signal() });
    } catch (error) {
      this.providerFailed("probe", error, { profileKey: profile.key });
      throw new PhisPaymentError("provider_unavailable");
    }
    const normalized = validatePhisPaymentProviderProbe(probe, profile);
    // For a recurring use only what can be stored. How (with a payment, or alone) is `stored.setup`, which
    // the caller that stores asks about; what a later charge may carry is `stored.pricing`, judged then.
    return normalized.methods.filter(m => m.features.captureModes.includes(input.captureMode) && m.features.checkoutKinds.includes(input.checkoutKind)
      && phisPaymentMethodSupports(m.features.pricing, input.pricing)
      && (input.usage !== "recurring" || m.features.stored != null)).map(method => ({ ...method, profileKey: profile.key }));
  }

  create(input: PhisPaymentCreateInput): Promise<PhisPaymentCommandResult> { return this.createPayment(input, null); }

  private async createPayment(input: PhisPaymentCreateInput, link: PeriodLink | null): Promise<PhisPaymentCommandResult> {
    input = structuredClone(input);
    const exponent = validatePhisPaymentMoney(input.amount);
    requirePhisPaymentReference(input.reference); requirePhisPaymentReference(input.idempotencyKey); requirePhisPaymentReference(input.profileKey);
    this.validateFlow(input.captureMode, input.checkoutKind);
    if (typeof input.description !== "string" || input.description.length < 1 || input.description.length > 200
      || (input.methodKey !== null && (typeof input.methodKey !== "string" || input.methodKey.length > 255))) throw new PhisPaymentError("invalid_input");
    const pricing = validatePhisPaymentPricing(input.pricing, input.amount);
    const store = input.store == null ? null : { payerReference: input.store.payerReference };
    if (store) requirePhisPaymentReference(store.payerReference);
    const profile = await this.profile(input.profileKey, "create");
    // Storing a method is a right of its own: a grant to take a payment does not include keeping the means.
    if (store) await this.profile(input.profileKey, "method-store");
    const request = { profileKey: input.profileKey, reference: input.reference, amount: { currency: input.amount.currency, minor: input.amount.minor }, pricing,
      description: input.description, captureMode: input.captureMode, methodKey: input.methodKey, checkoutKind: input.checkoutKind, returnPath: input.returnPath,
      ...(store ? { store } : {}) };
    // Idempotent retries are checked before a live availability probe; completed requests do not depend on the PSP answering.
    const previous = await withPoolTransaction(this.pool, db => findPhisPaymentIdempotency(db, this.scope, "create", input.idempotencyKey));
    if (previous) {
      if (!isDeepStrictEqual(previous.request, request)) throw new PhisPaymentError("idempotency_conflict");
      return this.resume(previous.record.id);
    }
    if (!profile.enabled || profile.retired || !profile.probedAt || !profile.merchantIdentity) throw new PhisPaymentError("profile_unavailable");
    const baseUrl = await this.options.publicBaseUrl();
    const id = randomUUID();
    const returnUrl = phisPaymentReturnUrl(baseUrl, input.returnPath, id);
    const available = await this.methods(profile, { amount: request.amount, captureMode: input.captureMode, checkoutKind: input.checkoutKind, pricing: phisPaymentPricingSelector(pricing),
      ...(store ? { usage: "recurring" as const } : {}) });
    const method = available.find(m => m.methodKey === input.methodKey);
    if (!method || (store && !method.features.stored?.setup.includes("with-payment"))) throw new PhisPaymentError("method_unavailable");
    // Known to the consumer from the first answer on, and `pending` until the Provider has the method.
    const storedMethod: PhisStoredPaymentMethod | null = store ? {
      siteId: this.scope.siteId, consumerAddonId: this.scope.consumerAddonId, features: method.features, binding: null,
      record: { id: randomUUID(), profileKey: profile.key, mode: profile.mode, payerReference: store.payerReference, methodKey: method.methodKey,
        display: { title: method.title.slice(0, 80), hint: null }, status: "pending", expiresAt: null, version: 1 },
    } : null;
    const providerId = profile.providerAddonId.slice(1).split("/").map(encodeURIComponent).join("/");
    const notificationUrl = new URL(`/api/hooks/${providerId}/payments/${encodeURIComponent(profile.key)}`, baseUrl).href;
    const operationId = randomUUID();
    const payment: PhisStoredPayment = {
      siteId: this.scope.siteId, consumerAddonId: this.scope.consumerAddonId, providerKey: profile.providerKey,
      merchantIdentity: profile.merchantIdentity!, profileRevision: profile.revision, currencyExponent: exponent, features: method.features,
      binding: null, generation: 0, leaseToken: null, leaseUntil: null,
      record: { id, reference: input.reference, profileKey: profile.key, mode: profile.mode, amount: request.amount, pricing, totals: null, captureMode: input.captureMode,
        status: "created", authorizedMinor: "0", capturedMinor: "0", refundedMinor: "0", authorizationExpiresAt: null,
        checkout: null, reconciliationRequired: true, version: 1, lastObservedAt: null, initiator: "customer", storedMethodId: storedMethod?.record.id ?? null,
        subscriptionId: link?.subscriptionId ?? null, periodIndex: link?.periodIndex ?? null },
    };
    const operation: PhisStoredPaymentOperation = {
      record: { id: operationId, paymentId: id, action: "create", state: "reserved", errorCode: null }, request,
      command: { action: "create", operationId, paymentId: id, providerIdempotencyKey: operationId, amount: request.amount, pricing,
        description: input.description, captureMode: input.captureMode, methodKey: input.methodKey, checkoutKind: input.checkoutKind, returnUrl, notificationUrl,
        ...(store ? { store } : {}) },
    };
    const reservation = await withPoolTransaction(this.pool, async db => {
      const found = await findPhisPaymentIdempotency(db, this.scope, "create", input.idempotencyKey);
      if (found) { if (!isDeepStrictEqual(found.request, request)) throw new PhisPaymentError("idempotency_conflict"); return found; }
      await this.checkProfileRevision(db, profile, "create");
      await insertPhisPayment(db, payment); await insertPhisPaymentOperation(db, this.scope, input.idempotencyKey, operation);
      if (storedMethod) await insertPhisPaymentStoredMethod(db, storedMethod);
      if (link) await this.notePeriodPayment(db, link, id, false);
      await writePhisPayment(db, payment, { operationId, refundId: null });
      await claimPhisPayment(db, payment);
      return null;
    });
    if (reservation) return this.resume(reservation.record.id);
    return this.runCommand(payment, profile, operation, false);
  }

  /**
   * Charges a stored method without the customer: an ordinary Payment that has no checkout.
   *
   * Not part of the consumer capability. It is what Core's schedule calls for a period that fell due,
   * under the consumer's stored agreement, and it is idempotent on the key the caller derives from that
   * agreement. The answer is one of three: the payment is captured (or pending where the Provider
   * notifies later), it failed with `payment_declined`, or it failed with `customer_action_required`
   * or `stored_method_unavailable`, after which no retry can succeed without the payer.
   */
  async chargeStoredMethod(input: {
    storedMethodId: string; reference: string; idempotencyKey: string; amount: PhisPaymentMoney; pricing: PhisPaymentPricing;
    description: string; initiator: "merchant" | "schedule"; subscription?: PeriodLink | null;
  }): Promise<PhisPaymentCommandResult> {
    input = structuredClone(input);
    const exponent = validatePhisPaymentMoney(input.amount);
    requirePhisPaymentReference(input.reference); requirePhisPaymentReference(input.idempotencyKey);
    if (typeof input.description !== "string" || input.description.length < 1 || input.description.length > 200
      || (input.initiator !== "merchant" && input.initiator !== "schedule")) throw new PhisPaymentError("invalid_input");
    const pricing = validatePhisPaymentPricing(input.pricing, input.amount);
    const found = await this.storedMethod(input.storedMethodId, "create");
    if (!found) throw new PhisPaymentError("not_found");
    const { method, profile } = found;
    const request = { storedMethodId: input.storedMethodId, reference: input.reference, amount: { currency: input.amount.currency, minor: input.amount.minor },
      pricing, description: input.description, initiator: input.initiator };
    const previous = await withPoolTransaction(this.pool, db => findPhisPaymentIdempotency(db, this.scope, "charge", input.idempotencyKey));
    if (previous) {
      if (!isDeepStrictEqual(previous.request, request)) throw new PhisPaymentError("idempotency_conflict");
      return this.resume(previous.record.id);
    }
    if (!profile.enabled || profile.retired || !profile.probedAt || !profile.merchantIdentity) throw new PhisPaymentError("profile_unavailable");
    if (method.record.status !== "active" || !method.binding) throw new PhisPaymentError("stored_method_unavailable");
    // Judged by the features the method was stored under: what was agreed then, with no live probe.
    const stored = method.features.stored;
    if (!stored || !phisPaymentMethodSupports(stored.pricing, phisPaymentPricingSelector(pricing))) throw new PhisPaymentError("unsupported_operation");
    const baseUrl = await this.options.publicBaseUrl();
    const providerId = profile.providerAddonId.slice(1).split("/").map(encodeURIComponent).join("/");
    const notificationUrl = new URL(`/api/hooks/${providerId}/payments/${encodeURIComponent(profile.key)}`, baseUrl).href;
    const id = randomUUID();
    const operationId = randomUUID();
    const payment: PhisStoredPayment = {
      siteId: this.scope.siteId, consumerAddonId: this.scope.consumerAddonId, providerKey: profile.providerKey,
      merchantIdentity: profile.merchantIdentity!, profileRevision: profile.revision, currencyExponent: exponent, features: method.features,
      binding: null, generation: 0, leaseToken: null, leaseUntil: null,
      record: { id, reference: input.reference, profileKey: profile.key, mode: profile.mode, amount: request.amount, pricing, totals: null, captureMode: "automatic",
        status: "created", authorizedMinor: "0", capturedMinor: "0", refundedMinor: "0", authorizationExpiresAt: null,
        checkout: null, reconciliationRequired: true, version: 1, lastObservedAt: null, initiator: input.initiator, storedMethodId: method.record.id,
        subscriptionId: input.subscription?.subscriptionId ?? null, periodIndex: input.subscription?.periodIndex ?? null },
    };
    const operation: PhisStoredPaymentOperation = {
      record: { id: operationId, paymentId: id, action: "charge", state: "reserved", errorCode: null }, request,
      command: { action: "charge", operationId, paymentId: id, providerIdempotencyKey: operationId, storedMethod: method.binding,
        payerReference: method.record.payerReference, amount: request.amount, pricing, description: input.description, methodKey: method.record.methodKey,
        sequence: input.initiator === "schedule" ? "scheduled" : "unscheduled", notificationUrl },
    };
    const reservation = await withPoolTransaction(this.pool, async db => {
      const existing = await findPhisPaymentIdempotency(db, this.scope, "charge", input.idempotencyKey);
      if (existing) { if (!isDeepStrictEqual(existing.request, request)) throw new PhisPaymentError("idempotency_conflict"); return existing; }
      await this.checkProfileRevision(db, profile, "create");
      // Under the lock, so a method revoked a moment ago is not charged by a request that read it before.
      const current = await readPhisPaymentStoredMethod(db, this.scope.siteId, method.record.id, this.scope.consumerAddonId, true);
      if (current?.record.status !== "active") throw new PhisPaymentError("stored_method_unavailable");
      await insertPhisPayment(db, payment); await insertPhisPaymentOperation(db, this.scope, input.idempotencyKey, operation);
      if (input.subscription) await this.notePeriodPayment(db, input.subscription, id, input.initiator === "schedule");
      await writePhisPayment(db, payment, { operationId, refundId: null });
      await claimPhisPayment(db, payment);
      return null;
    });
    if (reservation) return this.resume(reservation.record.id);
    return this.runCommand(payment, profile, operation, false);
  }

  /** Records a payment against its period, and counts it where the schedule made it. */
  private async notePeriodPayment(db: PoolClient, link: PeriodLink, paymentId: string, attempt: boolean) {
    const period = await readPhisPaymentSubscriptionPeriod(db, link.subscriptionId, link.periodIndex, true);
    // The first period has no row until its payment is captured; that payment is noted when it is.
    if (!period) return;
    period.record.paymentIds = [...period.record.paymentIds, paymentId];
    if (attempt) period.attempts += 1;
    await writePhisPaymentSubscriptionPeriod(db, period);
  }

  private validateTerms(value: PhisPaymentSubscriptionTerms): PhisPaymentSubscriptionTerms {
    if (!value || typeof value !== "object") throw new PhisPaymentError("invalid_input");
    validatePhisPaymentMoney(value.amount);
    if (typeof value.description !== "string" || value.description.length < 1 || value.description.length > 200) throw new PhisPaymentError("invalid_input");
    return { amount: { currency: value.amount.currency, minor: value.amount.minor }, pricing: validatePhisPaymentPricing(value.pricing, value.amount), description: value.description };
  }

  private async subscription(id: string, operation: PhisPaymentGrantedOperation): Promise<{ subscription: PhisStoredPaymentSubscription; profile: PhisPaymentProfile } | null> {
    requirePhisPaymentReference(id);
    const subscription = await readPhisPaymentSubscription(this.pool, this.scope.siteId, id, this.scope.consumerAddonId);
    if (!subscription) return null;
    try { return { subscription, profile: await this.profile(subscription.record.profileKey, operation) }; }
    catch (error) { if (error instanceof PhisPaymentError && error.code === "not_found") return null; throw error; }
  }

  async getSubscription(subscriptionId: string): Promise<PhisPaymentSubscription | null> {
    return (await this.subscription(subscriptionId, "subscription-read"))?.subscription.record ?? null;
  }

  async listSubscriptionPeriods(subscriptionId: string): Promise<readonly PhisPaymentSubscriptionPeriod[]> {
    if (!await this.subscription(subscriptionId, "subscription-read")) return [];
    return listPhisPaymentSubscriptionPeriods(this.pool, subscriptionId);
  }

  /**
   * The agreement first, as `pending`, then its first payment, which is an ordinary hosted payment that
   * also stores the method. What happens to that payment decides the rest: captured, the subscription is
   * active and its first period runs from then; ended without a capture, it is canceled.
   */
  async createSubscription(input: PhisPaymentSubscriptionCreateInput): Promise<PhisPaymentSubscriptionResult> {
    input = structuredClone(input);
    requirePhisPaymentReference(input.profileKey); requirePhisPaymentReference(input.reference); requirePhisPaymentReference(input.idempotencyKey);
    requirePhisPaymentReference(input.payerReference);
    // Period payments are referenced as `<reference>#<index>`, which has to stay a reference itself.
    if (input.reference.length > 200 || (input.methodKey !== null && (typeof input.methodKey !== "string" || input.methodKey.length > 255))) throw new PhisPaymentError("invalid_input");
    this.validateFlow("automatic", input.checkoutKind);
    const interval = validatePhisPaymentInterval(input.interval);
    const dunning = validatePhisPaymentDunningPolicy(input.dunning);
    const recurring = this.validateTerms(input.recurring);
    const first = this.validateTerms(input.first);
    if (recurring.amount.currency !== first.amount.currency) throw new PhisPaymentError("invalid_input");
    const profile = await this.profile(input.profileKey, "subscription-create");
    const request = { profileKey: input.profileKey, reference: input.reference, payerReference: input.payerReference, interval, recurring, first, dunning,
      methodKey: input.methodKey, checkoutKind: input.checkoutKind, returnPath: input.returnPath };
    const firstPayment = (id: string) => this.createPayment({ profileKey: input.profileKey, reference: `${input.reference}#0`, idempotencyKey: `subscription:${id}:first`,
      amount: first.amount, pricing: first.pricing, description: first.description, captureMode: "automatic", methodKey: input.methodKey,
      checkoutKind: input.checkoutKind, returnPath: input.returnPath, store: { payerReference: input.payerReference } }, { subscriptionId: id, periodIndex: 0 });

    const previous = await withPoolTransaction(this.pool, db => findPhisPaymentSubscriptionIdempotency(db, this.scope, input.idempotencyKey));
    if (previous) {
      if (!isDeepStrictEqual(previous.request, request)) throw new PhisPaymentError("idempotency_conflict");
      const payment = await firstPayment(previous.record.id);
      return { subscription: (await readPhisPaymentSubscription(this.pool, this.scope.siteId, previous.record.id, this.scope.consumerAddonId))!.record, payment };
    }
    if (!profile.enabled || profile.retired || !profile.probedAt || !profile.merchantIdentity) throw new PhisPaymentError("profile_unavailable");
    // Before anything is stored: the method has to be storable, and able to carry what a renewal costs.
    const available = await this.methods(profile, { amount: first.amount, captureMode: "automatic", checkoutKind: input.checkoutKind,
      pricing: phisPaymentPricingSelector(first.pricing), usage: "recurring" });
    const method = available.find(m => m.methodKey === input.methodKey);
    if (!method) throw new PhisPaymentError("method_unavailable");
    if (!method.features.stored || !phisPaymentMethodSupports(method.features.stored.pricing, phisPaymentPricingSelector(recurring.pricing))) throw new PhisPaymentError("unsupported_operation");

    const subscription: PhisStoredPaymentSubscription = {
      siteId: this.scope.siteId, consumerAddonId: this.scope.consumerAddonId, request, anchorAt: null, leaseToken: null,
      record: { id: randomUUID(), reference: input.reference, profileKey: profile.key, mode: profile.mode, payerReference: input.payerReference, storedMethodId: null,
        interval, recurring, dunning, status: "pending", customerActionRequired: false, period: null, nextChargeAt: null, cancelAtPeriodEnd: false, endedAt: null, version: 1 },
    };
    const raced = await withPoolTransaction(this.pool, async db => {
      const found = await findPhisPaymentSubscriptionIdempotency(db, this.scope, input.idempotencyKey);
      if (found) { if (!isDeepStrictEqual(found.request, request)) throw new PhisPaymentError("idempotency_conflict"); return found; }
      if (!await insertPhisPaymentSubscription(db, subscription, input.idempotencyKey)) throw new PhisPaymentError("active_attempt_exists");
      await writePhisPaymentSubscription(db, subscription, null);
      return null;
    });
    const id = raced?.record.id ?? subscription.record.id;
    let payment: PhisPaymentCommandResult;
    try { payment = await firstPayment(id); }
    catch (error) {
      // No payment came to exist, so nothing will ever settle this subscription; it ends here.
      await withPoolTransaction(this.pool, async db => {
        const current = await readPhisPaymentSubscription(db, this.scope.siteId, id, this.scope.consumerAddonId, true);
        if (current?.record.status === "pending") await this.endSubscription(db, current, new Date());
      });
      throw error;
    }
    return { subscription: (await readPhisPaymentSubscription(this.pool, this.scope.siteId, id, this.scope.consumerAddonId))!.record, payment };
  }

  /** Ends a subscription under its row lock: nothing further is charged, and an unpaid period is void. */
  private async endSubscription(db: PoolClient, subscription: PhisStoredPaymentSubscription, at: Date) {
    const openIndex = (subscription.record.period?.index ?? -1) + 1;
    const open = await readPhisPaymentSubscriptionPeriod(db, subscription.record.id, openIndex, true);
    // A period that already failed keeps saying so; only one still open becomes void.
    if (open && open.record.status === "open") { open.record.status = "void"; await writePhisPaymentSubscriptionPeriod(db, open); }
    Object.assign(subscription.record, { status: "canceled", endedAt: at.toISOString(), nextChargeAt: null, customerActionRequired: false, cancelAtPeriodEnd: false });
    subscription.record.version += 1;
    await writePhisPaymentSubscription(db, subscription, open ? openIndex : null);
  }

  /**
   * At the period end is what a customer asks for, through the consumer: nothing more is charged and what
   * was paid for is kept. A subscription with nothing paid ahead has no such end to wait for and ends at
   * once. Ending a paid subscription at once is the merchant's act, and refunds nothing by itself.
   */
  async cancelSubscription(input: Parameters<PhisPaymentsCapabilityV1["cancelSubscription"]>[0]): Promise<PhisPaymentSubscription | null> {
    if (input?.at !== "period-end" && input?.at !== "now") throw new PhisPaymentError("invalid_input");
    const found = await this.subscription(input.subscriptionId, "subscription-cancel");
    if (!found) return null;
    if (input.at === "now" && found.subscription.record.status === "active") {
      const grant = found.profile.grants.find(g => g.consumerAddonId === this.scope.consumerAddonId)!;
      const policy = grant.merchantActions.subscriptionEnd;
      if (!policy || !await this.options.merchantAuthorized("subscriptionEnd", policy)) throw new PhisPaymentError("forbidden");
    }
    const record = await withPoolTransaction(this.pool, async db => {
      const current = (await readPhisPaymentSubscription(db, this.scope.siteId, input.subscriptionId, this.scope.consumerAddonId, true))!;
      if (current.record.status === "canceled") return current.record;
      const paidAhead = current.record.status === "active" && current.record.period !== null && new Date(current.record.period.endsAt) > new Date();
      if (input.at === "period-end" && paidAhead) {
        if (!current.record.cancelAtPeriodEnd) {
          current.record.cancelAtPeriodEnd = true; current.record.version += 1;
          await writePhisPaymentSubscription(db, current, null);
        }
      } else await this.endSubscription(db, current, new Date());
      return current.record;
    });
    await this.options.afterCommit?.().catch(() => {});
    return record;
  }

  async resumeSubscription(subscriptionId: string): Promise<PhisPaymentSubscription | null> {
    if (!await this.subscription(subscriptionId, "subscription-cancel")) return null;
    const record = await withPoolTransaction(this.pool, async db => {
      const current = (await readPhisPaymentSubscription(db, this.scope.siteId, subscriptionId, this.scope.consumerAddonId, true))!;
      if (current.record.status !== "active" || !current.record.cancelAtPeriodEnd) throw new PhisPaymentError("invalid_state");
      current.record.cancelAtPeriodEnd = false; current.record.version += 1;
      await writePhisPaymentSubscription(db, current, null);
      return current.record;
    });
    await this.options.afterCommit?.().catch(() => {});
    return record;
  }

  /**
   * The customer pays the open period themselves, on a checkout, which stores the method anew. It is the
   * way back from "the customer has to return", and from a subscription Core stopped trying to charge.
   */
  async settleSubscription(input: Parameters<PhisPaymentsCapabilityV1["settleSubscription"]>[0]): Promise<PhisPaymentCommandResult> {
    requirePhisPaymentReference(input.idempotencyKey);
    const found = await this.subscription(input.subscriptionId, "subscription-cancel");
    if (!found) throw new PhisPaymentError("not_found");
    const { record } = found.subscription;
    if (record.status !== "past_due" && record.status !== "unpaid") throw new PhisPaymentError("invalid_state");
    const index = (record.period?.index ?? -1) + 1;
    const period = await readPhisPaymentSubscriptionPeriod(this.pool, record.id, index);
    if (!period) throw new PhisPaymentError("invalid_state");
    return this.createPayment({ profileKey: record.profileKey, reference: `${record.reference}#${index}`, idempotencyKey: `subscription:${record.id}:${index}:settle:${input.idempotencyKey}`,
      amount: period.record.amount, pricing: record.recurring.pricing, description: record.recurring.description, captureMode: "automatic", methodKey: input.methodKey,
      checkoutKind: input.checkoutKind, returnPath: input.returnPath, store: { payerReference: record.payerReference } }, { subscriptionId: record.id, periodIndex: index });
  }

  async replaceSubscriptionMethod(input: Parameters<PhisPaymentsCapabilityV1["replaceSubscriptionMethod"]>[0]): Promise<PhisPaymentSubscription | null> {
    const found = await this.subscription(input.subscriptionId, "subscription-cancel");
    if (!found) return null;
    const method = await this.storedMethod(input.storedMethodId, "method-read");
    if (!method) throw new PhisPaymentError("not_found");
    const record = await withPoolTransaction(this.pool, async db => {
      const current = (await readPhisPaymentSubscription(db, this.scope.siteId, input.subscriptionId, this.scope.consumerAddonId, true))!;
      const target = await readPhisPaymentStoredMethod(db, this.scope.siteId, input.storedMethodId, this.scope.consumerAddonId, true);
      if (current.record.status === "canceled" || current.record.status === "pending") throw new PhisPaymentError("invalid_state");
      if (!target || target.record.status !== "active" || target.record.payerReference !== current.record.payerReference
        || target.record.profileKey !== current.record.profileKey) throw new PhisPaymentError("stored_method_unavailable");
      if (current.record.storedMethodId === target.record.id && !current.record.customerActionRequired) return current.record;
      current.record.storedMethodId = target.record.id;
      // With a method that may work, the schedule tries again at its next run instead of waiting out the time.
      if (current.record.status === "past_due" && current.record.customerActionRequired) {
        current.record.customerActionRequired = false; current.record.nextChargeAt = new Date().toISOString();
      }
      current.record.version += 1;
      await writePhisPaymentSubscription(db, current, null);
      return current.record;
    });
    await this.options.afterCommit?.().catch(() => {});
    return record;
  }

  /**
   * What a payment's state means for the subscription it belongs to. Called in the payment's transaction,
   * for every observation, so it has to be right when called twice and when called late.
   */
  private async settleSubscriptionPayment(db: PoolClient, payment: PhisStoredPayment, errorCode: PhisPaymentErrorCode | null) {
    const subscription = await readPhisPaymentSubscription(db, payment.siteId, payment.record.subscriptionId!, null, true);
    const index = payment.record.periodIndex;
    // A subscription that has ended stays ended; a payment captured afterwards is the consumer's to refund,
    // and it learns of it from the payment's own event.
    if (!subscription || index === null || subscription.record.status === "canceled") return;
    const { record } = subscription;
    const status = payment.record.status;
    const now = new Date();

    if (record.status === "pending") {
      if (index !== 0) return;
      if (status === "captured") {
        const endsAt = addPhisPaymentIntervals(now, record.interval, 1).toISOString();
        await ensurePhisPaymentSubscriptionPeriod(db, { subscriptionId: record.id, index: 0, startsAt: now.toISOString(), endsAt,
          amount: payment.record.amount, status: "paid", paymentIds: [payment.record.id] });
        subscription.anchorAt = now.toISOString();
        Object.assign(record, { status: "active", period: { index: 0, startsAt: now.toISOString(), endsAt }, storedMethodId: payment.record.storedMethodId, nextChargeAt: endsAt });
      } else if (ENDED_PAYMENT.includes(status)) {
        Object.assign(record, { status: "canceled", endedAt: now.toISOString(), nextChargeAt: null });
      } else return;
      record.version += 1;
      await writePhisPaymentSubscription(db, subscription, 0);
      return;
    }

    const period = await readPhisPaymentSubscriptionPeriod(db, record.id, index, true);
    if (!period || period.record.status === "paid" || period.record.status === "void" || index !== (record.period?.index ?? -1) + 1) return;
    if (status === "captured") {
      period.record.status = "paid";
      await writePhisPaymentSubscriptionPeriod(db, period);
      Object.assign(record, { status: "active", customerActionRequired: false, nextChargeAt: period.record.endsAt,
        period: { index, startsAt: period.record.startsAt, endsAt: period.record.endsAt } });
      // The customer paid on a checkout that stored a method: that is the one to charge from now on.
      if (payment.record.initiator === "customer" && payment.record.storedMethodId) record.storedMethodId = payment.record.storedMethodId;
    } else if (ENDED_PAYMENT.includes(status) && payment.record.initiator === "schedule" && period.record.status === "open"
      && period.record.paymentIds.at(-1) === payment.record.id) {
      const dueAt = new Date(period.record.startsAt);
      const needsCustomer = errorCode === "customer_action_required" || errorCode === "stored_method_unavailable";
      const next = needsCustomer ? phisPaymentDunningDeadline(dueAt, record.dunning) : nextPhisPaymentDunningAttempt(dueAt, record.dunning, period.attempts);
      if (next && (!needsCustomer || next > now)) {
        Object.assign(record, { status: "past_due", customerActionRequired: needsCustomer, nextChargeAt: next.toISOString() });
      } else {
        await this.exhaustSubscriptionPeriod(db, subscription, index, now);
        return;
      }
    } else return;
    record.version += 1;
    await writePhisPaymentSubscription(db, subscription, index);
  }

  /**
   * The schedule's turn at one subscription: what Core does on its own when `nextChargeAt` has come.
   *
   * Called by the scheduler under its lease, with this engine scoped to the subscription's consumer. It
   * decides under the row lock and charges outside it, and it never charges while an earlier payment for
   * the same period is unresolved: that one is asked about first, and the answer does the rest.
   */
  async advanceSubscription(subscriptionId: string, now = new Date()): Promise<{ postponed: unknown } | null> {
    const due = await withPoolTransaction(this.pool, async db => {
      const subscription = await readPhisPaymentSubscription(db, this.scope.siteId, subscriptionId, this.scope.consumerAddonId, true);
      const record = subscription?.record;
      if (!subscription || !record?.nextChargeAt || new Date(record.nextChargeAt) > now) return null;
      if (record.status !== "active" && record.status !== "past_due") return null;
      const index = (record.period?.index ?? -1) + 1;
      if (record.status === "active") {
        // The paid period is over. A cancelled subscription ends with it; another is owed its next period.
        if (record.cancelAtPeriodEnd) { await this.endSubscription(db, subscription, new Date(record.period!.endsAt)); return null; }
        const period = await ensurePhisPaymentSubscriptionPeriod(db, { subscriptionId: record.id, index, startsAt: record.period!.endsAt,
          endsAt: addPhisPaymentIntervals(new Date(subscription.anchorAt!), record.interval, index + 1).toISOString(),
          amount: record.recurring.amount, status: "open", paymentIds: [] });
        return { record, period, index };
      }
      const period = await readPhisPaymentSubscriptionPeriod(db, record.id, index, true);
      if (!period) return null;
      // The customer was waited for and did not come.
      if (record.customerActionRequired) { await this.exhaustSubscriptionPeriod(db, subscription, index, now); return null; }
      const next = nextPhisPaymentDunningAttempt(new Date(period.record.startsAt), record.dunning, period.attempts);
      if (!next) { await this.exhaustSubscriptionPeriod(db, subscription, index, now); return null; }
      return { record, period, index };
    });
    if (!due) { await this.options.afterCommit?.().catch(() => {}); return null; }
    const { record, period, index } = due;

    const lastId = period.record.paymentIds.at(-1);
    const last = lastId ? await readPhisPayment(this.pool, this.scope.siteId, lastId, this.scope.consumerAddonId) : null;
    if (last && (last.record.reconciliationRequired || (last.record.status !== "captured" && !ENDED_PAYMENT.includes(last.record.status)))) {
      const profile = await readPhisPaymentProfile(this.pool, this.scope.siteId, record.profileKey);
      if (profile) await this.reconcile(last, profile).catch(() => {});
      return null;
    }
    const needsCustomer = () => withPoolTransaction(this.pool, async db => {
      const subscription = await readPhisPaymentSubscription(db, this.scope.siteId, subscriptionId, this.scope.consumerAddonId, true);
      if (!subscription || subscription.record.version !== record.version) return;
      const deadline = phisPaymentDunningDeadline(new Date(period.record.startsAt), record.dunning);
      if (deadline <= now) { await this.exhaustSubscriptionPeriod(db, subscription, index, now); return; }
      Object.assign(subscription.record, { status: "past_due", customerActionRequired: true, nextChargeAt: deadline.toISOString() });
      subscription.record.version += 1;
      await writePhisPaymentSubscription(db, subscription, index);
    });
    try {
      if (!record.storedMethodId) throw new PhisPaymentError("stored_method_unavailable");
      await this.chargeStoredMethod({ storedMethodId: record.storedMethodId, reference: `${record.reference}#${index}`,
        idempotencyKey: `subscription:${record.id}:${index}:${period.attempts + 1}`, amount: period.record.amount, pricing: record.recurring.pricing,
        description: record.recurring.description, initiator: "schedule", subscription: { subscriptionId: record.id, periodIndex: index } });
    } catch (error) {
      if (error instanceof PhisPaymentError && error.code === "stored_method_unavailable") await needsCustomer();
      /*
       * Anything else kept the charge from being made at all: a profile that is disabled, a grant that was
       * withdrawn, a Provider that did not answer. No attempt was used, so the schedule looks again in an
       * hour instead of counting a failure the customer did not cause -- and says why, because a
       * subscription that is put off every hour for ever is otherwise invisible.
       */
      else {
        await postponePhisPaymentSubscription(this.pool, subscriptionId, new Date(now.getTime() + 3_600_000));
        return { postponed: error };
      }
    }
    await this.options.afterCommit?.().catch(() => {});
    return null;
  }

  /** The time allowed for a period has run out: it has failed, and the policy says what follows. */
  private async exhaustSubscriptionPeriod(db: PoolClient, subscription: PhisStoredPaymentSubscription, index: number, now: Date) {
    const period = await readPhisPaymentSubscriptionPeriod(db, subscription.record.id, index, true);
    if (period && period.record.status === "open") { period.record.status = "failed"; await writePhisPaymentSubscriptionPeriod(db, period); }
    if (subscription.record.dunning.onExhausted === "cancel") { await this.endSubscription(db, subscription, now); return; }
    Object.assign(subscription.record, { status: "unpaid", nextChargeAt: null });
    subscription.record.version += 1;
    await writePhisPaymentSubscription(db, subscription, index);
  }

  private async checkProfileRevision(db: PoolClient, expected: PhisPaymentProfile, action: PhisPaymentGrantedOperation) {
    const current = await readPhisPaymentProfile(db, this.scope.siteId, expected.key, true);
    if (!current || current.revision !== expected.revision || !current.grants.find(g => g.consumerAddonId === this.scope.consumerAddonId)?.operations.includes(action)) throw new PhisPaymentError("profile_unavailable");
  }

  complete(input: MutationInput) { return this.mutate("complete", input); }
  cancel(input: MutationInput) { return this.mutate("cancel", input); }
  capture(input: MutationInput & { minor: string }) { return this.mutate("capture", input); }
  refund(input: MutationInput & { minor: string; reason: string }) { return this.mutate("refund", input); }

  private async mutate(action: MutationAction, input: MutationInput): Promise<PhisPaymentCommandResult> {
    input = structuredClone(input);
    requirePhisPaymentReference(input.paymentId); requirePhisPaymentReference(input.idempotencyKey);
    if (action === "capture" || action === "refund") requirePhisPaymentMinor(input.minor, true);
    if (action === "refund" && (typeof input.reason !== "string" || input.reason.length > 500)) throw new PhisPaymentError("invalid_input");
    const found = await this.persisted(input.paymentId, action);
    if (!found) throw new PhisPaymentError("not_found");
    const request = { paymentId: input.paymentId, ...(action === "capture" || action === "refund" ? { minor: input.minor } : {}), ...(action === "refund" ? { reason: input.reason } : {}) };
    const result = await withPoolTransaction(this.pool, async db => {
      const previous = await findPhisPaymentIdempotency(db, this.scope, action, input.idempotencyKey);
      if (previous) { if (!isDeepStrictEqual(previous.request, request)) throw new PhisPaymentError("idempotency_conflict"); return { previous }; }
      await this.checkProfileRevision(db, found.profile, action);
      const payment = (await readPhisPayment(db, this.scope.siteId, input.paymentId, this.scope.consumerAddonId, true))!;
      const operations = await listPhisPaymentOperations(db, input.paymentId);
      if (payment.record.reconciliationRequired || operations.some(o => ["reserved", "indeterminate"].includes(o.record.state))) throw new PhisPaymentError("reconciliation_required");
      if (!payment.binding || !await claimPhisPayment(db, payment)) throw new PhisPaymentError("invalid_state");
      const minor = input.minor;
      if (action === "cancel" && !payment.features.canCancel) throw new PhisPaymentError("unsupported_operation");
      if (action === "capture" && !payment.features.captureModes.includes("manual")) throw new PhisPaymentError("unsupported_operation");
      if (action === "capture" && !payment.features.canPartialCapture && input.minor !== payment.record.authorizedMinor) throw new PhisPaymentError("unsupported_operation");
      if (action === "refund" && !payment.features.canRefund) throw new PhisPaymentError("unsupported_operation");

      if (action === "capture" && (payment.record.captureMode !== "manual" || payment.record.status !== "authorized" || BigInt(minor!) > BigInt(payment.record.authorizedMinor))) throw new PhisPaymentError("invalid_state");
      if (action === "cancel" && !["awaiting_customer", "authorized"].includes(payment.record.status)) throw new PhisPaymentError("invalid_state");
      const refunds = await listPhisPaymentRefunds(db, input.paymentId);
      if (action === "refund") {
        const reserved = refunds.filter(r => ["pending", "succeeded"].includes(r.record.status)).reduce((sum, r) => sum + BigInt(r.record.amount.minor), BigInt(0));
        if (!payment.features.canPartialRefund && BigInt(minor!) !== BigInt(payment.record.capturedMinor) - reserved) throw new PhisPaymentError("unsupported_operation");
        if (payment.record.status !== "captured" || reserved + BigInt(minor!) > BigInt(payment.record.capturedMinor)) throw new PhisPaymentError("invalid_state");
      }
      const operationId = randomUUID();
      const common = { operationId, paymentId: input.paymentId, providerIdempotencyKey: operationId, binding: payment.binding };
      const command: PhisStoredPaymentCommand = action === "capture" ? { ...common, action, minor: minor! }
        : action === "refund" ? { ...common, action, minor: minor!, reason: input.reason! } : { ...common, action };
      const operation: PhisStoredPaymentOperation = { record: { id: operationId, paymentId: input.paymentId, action, state: "reserved", errorCode: null }, request, command };
      await insertPhisPaymentOperation(db, this.scope, input.idempotencyKey, operation);
      const refund: PhisStoredPaymentRefund | null = action === "refund" ? {
        record: { id: randomUUID(), paymentId: input.paymentId, amount: { currency: payment.record.amount.currency, minor: minor! }, additions: null, status: "pending" },
        binding: null, operationId,
      } : null;
      if (refund) await writePhisPaymentRefund(db, refund);
      payment.record.reconciliationRequired = true; payment.record.version += 1;
      // Write reservation facts without releasing the claim that protects the following external call.
      await writePhisPayment(db, payment, { operationId, refundId: refund?.record.id ?? null });
      await claimPhisPayment(db, payment);
      return { payment, operation };
    });
    if (result.previous) return this.resume(result.previous.record.id);
    return this.runCommand(result.payment!, found.profile, result.operation!, false);
  }

  private async result(db: Pick<PoolClient, "query">, payment: PhisStoredPayment, operationId: string): Promise<PhisPaymentCommandResult> {
    const operation = await readPhisPaymentOperation(db, operationId, this.scope);
    if (!operation) throw new PhisPaymentError("not_found");
    const refund = (await listPhisPaymentRefunds(db, payment.record.id)).find(r => r.operationId === operationId);
    return { payment: payment.record, operation: operation.record, refund: refund?.record ?? null };
  }

  private async resume(operationId: string): Promise<PhisPaymentCommandResult> {
    const operation = (await readPhisPaymentOperation(this.pool, operationId, this.scope))!;
    const found = await this.persisted(operation.record.paymentId, grantedFor(operation.record.action));
    if (!found) throw new PhisPaymentError("not_found");
    if (["succeeded", "failed"].includes(operation.record.state)) return this.result(this.pool, found.payment, operationId);
    const payment = await withPoolTransaction(this.pool, async db => {
      const locked = (await readPhisPayment(db, this.scope.siteId, found.payment.record.id, this.scope.consumerAddonId, true))!;
      return await claimPhisPayment(db, locked) ? locked : null;
    });
    if (!payment) return this.result(this.pool, found.payment, operationId);
    return this.runCommand(payment, found.profile, operation, true);
  }

  private async runCommand(payment: PhisStoredPayment, profile: PhisPaymentProfile, operation: PhisStoredPaymentOperation, recover: boolean) {
    let result: PhisPaymentProviderExecution;
    try {
      const provider = await this.options.resolveProvider(profile);
      const command = { ...operation.command, signal: this.signal() };
      // db-boundary-exempt: the Provider executes a PSP HTTP command and receives no database handle.
      result = recover ? await provider.recover({ command, binding: payment.binding }) : await provider.execute(command);
    } catch (error) {
      this.providerFailed(recover ? "recover" : "execute", error, { profileKey: profile.key, paymentId: payment.record.id, operationId: operation.record.id });
      result = { outcome: "unknown" };
    }
    try { await this.apply(payment, profile, result, operation.record.id); }
    catch {
      // Invalid observations after submission preserve the durable operation and its reservation.
      await this.apply(payment, profile, { outcome: "unknown" }, operation.record.id);
    }
    await this.options.afterCommit?.().catch(() => {});
    const latest = (await readPhisPayment(this.pool, this.scope.siteId, payment.record.id, this.scope.consumerAddonId))!;
    return this.result(this.pool, latest, operation.record.id);
  }

  async refresh(paymentId: string) {
    const found = await this.persisted(paymentId, "refresh");
    if (!found) return null;
    await this.reconcile(found.payment, found.profile);
    return (await readPhisPayment(this.pool, this.scope.siteId, paymentId, this.scope.consumerAddonId))!.record;
  }

  /** Also used by the operator and narrow verified notification ingress, without impersonating an actor. */
  async reconcile(payment: PhisStoredPayment, profile: PhisPaymentProfile, receipt?: PhisPaymentReceipt) {
    const claimed = await withPoolTransaction(this.pool, async db => {
      const locked = await readPhisPayment(db, payment.siteId, payment.record.id, null, true);
      if (!locked || !await claimPhisPayment(db, locked)) throw new PhisPaymentError("provider_unavailable");
      return locked;
    });
    let result: PhisPaymentProviderExecution;
    let operationId: string | null = null;
    try {
      const provider = await this.options.resolveProvider(profile);
      const unresolved = (await listPhisPaymentOperations(this.pool, claimed.record.id)).filter(o => ["reserved", "pending", "indeterminate"].includes(o.record.state));
      const recovery = unresolved.find(o => o.record.action === "create" || o.record.action === "charge") ?? unresolved[0];
      if (recovery) {
        operationId = recovery.record.id;
        result = await provider.recover({ command: { ...recovery.command, signal: this.signal() }, binding: claimed.binding });
        // Unknown command outcomes do not prevent observing already-bound remote financial facts.
        if (result.outcome === "unknown" && claimed.binding) result = { outcome: "pending", observation: await provider.observe({ binding: claimed.binding, signal: this.signal() }) };
      } else if (claimed.binding) result = { outcome: "applied", observation: await provider.observe({ binding: claimed.binding, signal: this.signal() }) };
      else throw new PhisPaymentError("reconciliation_required");
      if (result.outcome === "unknown" || result.outcome === "rejected") throw new PhisPaymentError("provider_unavailable");
    } catch (error) {
      if (!(error instanceof PhisPaymentError)) this.providerFailed("reconcile", error, { profileKey: profile.key, paymentId: claimed.record.id, operationId });
      await this.apply(claimed, profile, { outcome: "unknown" }, operationId);
      throw new PhisPaymentError("provider_unavailable");
    }
    try { await this.apply(claimed, profile, result, operationId, receipt); }
    catch (error) { await this.apply(claimed, profile, { outcome: "unknown" }, operationId); throw error; }
    await this.options.afterCommit?.().catch(() => {});
  }

  private async apply(claimed: PhisStoredPayment, profile: PhisPaymentProfile, result: PhisPaymentProviderExecution, operationId: string | null, receipt?: PhisPaymentReceipt) {
    if (!result || !["applied", "pending", "rejected", "unknown"].includes(result.outcome)
      || (result.outcome === "rejected" && !PHIS_PAYMENT_ERROR_CODES.includes(result.code))) throw new PhisPaymentError("provider_unavailable");
    await withPoolTransaction(this.pool, async db => {
      const payment = (await readPhisPayment(db, claimed.siteId, claimed.record.id, null, true))!;
      if (!payment || payment.generation !== claimed.generation || payment.leaseToken !== claimed.leaseToken) throw new PhisPaymentError("provider_unavailable");
      const operations = await listPhisPaymentOperations(db, payment.record.id);
      const beforeOperations = structuredClone(operations.map(o => o.record));
      const refunds = await listPhisPaymentRefunds(db, payment.record.id);
      const beforeRefunds = structuredClone(refunds.map(r => r.record));
      const before = structuredClone(payment.record);
      const operation = operations.find(o => o.record.id === operationId);
      let changedRefundId: string | null = null;
      if (result.outcome === "applied" || result.outcome === "pending") {
        validatePhisPaymentObservation(payment, profile, result.observation);
        // A charge has nobody to wait for: a Provider that needs the customer says so by rejecting it.
        if (payment.record.initiator !== "customer" && result.observation.status === "awaiting_customer") throw new PhisPaymentError("provider_unavailable");
        changedRefundId = this.applyObservation(payment, result.observation, operations, refunds);
        if (operation && operation.record.action !== "refund") {
          const confirmed = operation.record.action === "create" || operation.record.action === "charge" || operation.record.action === "complete"
            || (operation.record.action === "capture" && result.observation.status === "captured" && "minor" in operation.command && result.observation.capturedMinor === operation.command.minor)
            || (operation.record.action === "cancel" && ["canceled", "expired"].includes(result.observation.status));
          if (confirmed) {
            operation.record.state = result.outcome === "pending" && ["create", "charge", "complete"].includes(operation.record.action) ? "pending" : "succeeded";
            operation.record.errorCode = null;
          }
          else { operation.record.state = "indeterminate"; operation.record.errorCode = "reconciliation_required"; }
        }
      } else if (operation) {
        operation.record.state = result.outcome === "rejected" ? "failed" : "indeterminate";
        operation.record.errorCode = result.outcome === "rejected" ? result.code : "reconciliation_required";
        if (result.outcome === "rejected" && (operation.record.action === "create" || operation.record.action === "charge")) payment.record.status = "failed";
        if (result.outcome === "rejected" && operation.record.action === "refund") {
          const refund = refunds.find(r => r.operationId === operationId);
          if (refund) { refund.record.status = "failed"; changedRefundId = refund.record.id; }
        }
      }
      for (const op of operations) await writePhisPaymentOperation(db, op);
      for (const refund of refunds) await writePhisPaymentRefund(db, refund);
      payment.record.reconciliationRequired = operations.some(o => ["reserved", "indeterminate"].includes(o.record.state));
      const reportedMethod = (result.outcome === "applied" || result.outcome === "pending") && result.observation.storedMethod
        ? validatePhisPaymentProviderStoredMethod(result.observation.storedMethod) : null;
      // The method is part of what the consumer is told changed: it may become active after the capture.
      const methodChanged = await this.settleStoredMethod(db, payment, reportedMethod, result.outcome === "rejected" ? result.code : null);
      const comparable = { ...payment.record, lastObservedAt: before.lastObservedAt };
      const changed = methodChanged || !isDeepStrictEqual(before, comparable) || !isDeepStrictEqual(beforeOperations, operations.map(o => o.record)) || !isDeepStrictEqual(beforeRefunds, refunds.map(r => r.record));
      if (changed) payment.record.version += 1;
      await writePhisPayment(db, payment, changed ? { operationId, refundId: changedRefundId } : null);
      // In the payment's own transaction: the period is paid exactly when the payment says it is.
      if (payment.record.subscriptionId) await this.settleSubscriptionPayment(db, payment, operation?.record.errorCode ?? null);
      if (receipt) await finishPhisPaymentReceipt(db, payment.siteId, receipt);
    });
  }

  private applyObservation(payment: PhisStoredPayment, observation: PhisPaymentProviderObservation, operations: PhisStoredPaymentOperation[], refunds: PhisStoredPaymentRefund[]) {
    let changedRefundId: string | null = null;
    for (const remote of observation.refunds) {
      const operation = remote.operationId ? operations.find(o => o.record.id === remote.operationId && o.record.action === "refund") : null;
      if (remote.operationId && !operation) throw new PhisPaymentError("provider_unavailable");
      const bound = refunds.find(r => r.binding?.reference === remote.binding.reference);
      const correlated = remote.operationId ? refunds.find(r => r.operationId === remote.operationId) : null;
      if (bound && correlated && bound.record.id !== correlated.record.id) throw new PhisPaymentError("provider_unavailable");
      let refund = correlated ?? bound;
      if (refund && (refund.record.amount.minor !== remote.minor || (refund.binding && !isDeepStrictEqual(refund.binding, remote.binding))
        || (refund.record.status === "succeeded" && remote.status !== "succeeded"))) throw new PhisPaymentError("provider_unavailable");
      if (!refund) {
        refund = { record: { id: randomUUID(), paymentId: payment.record.id, amount: { currency: payment.record.amount.currency, minor: remote.minor }, additions: null, status: remote.status },
          operationId: remote.operationId, binding: { reference: remote.binding.reference, data: { ...remote.binding.data } } };
        refunds.push(refund); changedRefundId = refund.record.id;
      }
      if (refund.record.status !== remote.status) changedRefundId = refund.record.id;
      if (remote.additions !== null) {
        const additions = copyPhisPaymentAdditions(remote.additions);
        if (refund.record.additions !== null && !isDeepStrictEqual(refund.record.additions, additions)) throw new PhisPaymentError("provider_unavailable");
        if (refund.record.additions === null) { refund.record.additions = additions; changedRefundId = refund.record.id; }
      }
      refund.binding = { reference: remote.binding.reference, data: { ...remote.binding.data } }; refund.record.status = remote.status;
      if (operation) {
        operation.record.state = remote.status === "pending" ? "pending" : remote.status === "succeeded" ? "succeeded" : "failed";
        operation.record.errorCode = ["failed", "canceled"].includes(remote.status) ? "provider_rejected" : null;
      }
    }
    // A complete PSP snapshot cannot make a previously observed remote refund disappear.
    if (refunds.some(r => r.binding && !observation.refunds.some(remote => remote.binding.reference === r.binding!.reference))) throw new PhisPaymentError("provider_unavailable");
    const reserved = refunds.filter(r => ["pending", "succeeded"].includes(r.record.status)).reduce((sum, r) => sum + BigInt(r.record.amount.minor), BigInt(0));
    if (reserved > BigInt(observation.capturedMinor)) throw new PhisPaymentError("provider_unavailable");
    const refundedMinor = refunds.filter(r => r.record.status === "succeeded").reduce((sum, r) => sum + BigInt(r.record.amount.minor), BigInt(0)).toString();
    payment.binding = { reference: observation.binding.reference, data: { ...observation.binding.data } };
    // Totals bind the first time the Provider reports them for authorized or captured funds; see validateObservedTotals.
    const totals = observation.totals === null ? payment.record.totals : normalizePhisPaymentTotals(observation.totals,
      payment.record.totals?.frozenAt ?? (["authorized", "captured"].includes(observation.status) ? new Date().toISOString() : null));
    Object.assign(payment.record, { status: observation.status, authorizedMinor: observation.authorizedMinor, capturedMinor: observation.capturedMinor,
      refundedMinor, totals, authorizationExpiresAt: observation.authorizationExpiresAt,
      checkout: observation.checkout?.kind === "redirect" ? { kind: "redirect", url: new URL(observation.checkout.url).href, expiresAt: observation.checkout.expiresAt } : null,
      lastObservedAt: new Date().toISOString() });
    // Resolve earlier create/complete/capture/cancel commands only from current authoritative evidence.
    for (const operation of operations.filter(o => ["reserved", "pending", "indeterminate"].includes(o.record.state))) {
      if (operation.record.action === "create" || operation.record.action === "charge"
        || (operation.record.action === "complete" && ["authorized", "captured", "canceled", "expired", "failed"].includes(observation.status))
        || (operation.record.action === "capture" && observation.status === "captured" && "minor" in operation.command && operation.command.minor === observation.capturedMinor)
        || (operation.record.action === "cancel" && ["expired", "canceled"].includes(observation.status))) {
        operation.record.state = "succeeded"; operation.record.errorCode = null;
      }
    }
    return changedRefundId;
  }
}
