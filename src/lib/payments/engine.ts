import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type {
  PhisPaymentCheckoutPlan, PhisPaymentCollection, PhisPaymentCollectionMode, PhisPaymentCommandResult, PhisPaymentCreateInput, PhisPaymentErrorCode,
  PhisPaymentGrantedOperation, PhisPaymentInterval, PhisPaymentIntervalFeatures, PhisPaymentMerchantActionPolicy, PhisPaymentMoney,
  PhisPaymentPricing, PhisPaymentProfileFeatures, PhisPaymentProfileSummary, PhisPaymentProviderExecution, PhisPaymentProviderObservation,
  PhisPaymentProviderStoredMethod, PhisPaymentProviderV1, PhisPaymentSettlement, PhisPaymentStoredMethod, PhisPaymentSubscription,
  PhisPaymentSubscriptionChange, PhisPaymentSubscriptionChangeQuote, PhisPaymentSubscriptionChangeRequest, PhisPaymentSubscriptionChangeResult,
  PhisPaymentSubscriptionCreateInput, PhisPaymentSubscriptionPeriod, PhisPaymentSubscriptionResult, PhisPaymentSubscriptionTerms, PhisPaymentsCapabilityV1,
} from "@phis/contracts/payments";
import {
  PhisPaymentCurrencyFeatureFlag, PhisPaymentDocumentFeatureFlag, PhisPaymentFeatureFlag, PhisPaymentFlag, PhisPaymentSubscriptionFlag,
} from "@phis/contracts/payments";
import {
  PHIS_PAYMENT_PERIOD_MOMENT_FLAG, ensurePhisPaymentSubscriptionPeriod, findPhisPaymentSubscriptionChangeByPayment, findPhisPaymentSubscriptionChangeIdempotency,
  findPhisPaymentSubscriptionIdempotency, insertPhisPaymentSubscription, insertPhisPaymentSubscriptionChange, isPhisPaymentStoredMethodInUse,
  listPhisPaymentSubscriptionChanges, listPhisPaymentSubscriptionPeriods, listPhisPaymentSubscriptionsOnMethod, postponePhisPaymentSubscription,
  readPhisPaymentSubscription, readPhisPaymentSubscriptionChange, readPhisPaymentSubscriptionPeriod, writePhisPaymentSubscription,
  writePhisPaymentSubscriptionChange, writePhisPaymentSubscriptionPeriod, type PhisPaymentSubscriptionMoment, type PhisStoredPaymentSubscriptionPeriod,
} from "../../db/payment-subscriptions.mts";
import {
  PHIS_PAYMENT_GRACE_MAX_DAYS, PHIS_PAYMENT_LEAD_MAX_DAYS, PHIS_PAYMENT_REMINDER_DAYS, addPhisPaymentDays, addPhisPaymentIntervals, nextPhisPaymentDunningAttempt,
  phisPaymentUnusedShare, validatePhisPaymentDays, validatePhisPaymentDunningPolicy, validatePhisPaymentInterval,
} from "./schedule.ts";
import {
  claimPhisPayment, claimPhisPaymentProfileRefresh, recordPhisPaymentProfileFeatures, rememberPhisPaymentNotification, settlePhisPaymentNotification, findPhisPaymentIdempotency, insertPhisPayment, insertPhisPaymentOperation,
  listPhisPaymentOperations, listPhisPaymentProfilesGrantedTo, listPhisPaymentRefunds, readPhisPayment, readPhisPaymentOperation, readPhisPaymentProfile,
  readPhisPaymentRefund, writePhisPayment, writePhisPaymentOperation, writePhisPaymentRefund, finishPhisPaymentReceipt,
  findPhisPaymentStoredMethodSetup, insertPhisPaymentStoredMethod, listPhisPaymentStoredMethods, readPhisPaymentStoredMethod,
  revokeSupersededPhisPaymentStoredMethods, writePhisPaymentStoredMethod, writePhisPaymentStoredMethodSetupCheckout,
} from "../../db/payments.mts";
import { enqueuePhisPaymentRecordTasks, listPhisPaymentSettlements } from "../../db/payment-records.mts";
import { withPoolTransaction } from "../db-transaction.ts";
import {
  PHIS_PAYMENT_CALL_TIMEOUT_MS, PHIS_PAYMENT_ERROR_CODES, PHIS_PAYMENT_KNOCK_REPEATS, PHIS_PAYMENT_REACH_MAX_CURRENCIES, PHIS_PAYMENT_REACH_REFRESH_SECONDS,
} from "../constants/payments.ts";
import { choosePhisPaymentCollection, phisPaymentMethodCollects, probePhisPaymentProfileCurrency, readPhisPaymentProfileFeatures } from "./profile-features.ts";
import { PhisPaymentError, copyPhisPaymentAdditions, normalizePhisPaymentTotals, phisPaymentMethodSupports, phisPaymentPricingSelector,
  phisPaymentReturnUrl, requirePhisPaymentCurrency, requirePhisPaymentMinor, requirePhisPaymentReference, validatePhisPaymentExpiresAt, validatePhisPaymentMoney, validatePhisPaymentObservation,
  validatePhisPaymentPricing, validatePhisPaymentPricingSelector, validatePhisPaymentProviderProbe, validatePhisPaymentProviderStoredMethod } from "./validation.ts";
import type {
  PhisPaymentProfile, PhisPaymentReceipt, PhisPaymentScope, PhisStoredPayment, PhisStoredPaymentCommand, PhisStoredPaymentMethod,
  PhisStoredPaymentOperation, PhisStoredPaymentRefund, PhisStoredPaymentSubscription, PhisStoredPaymentSubscriptionChange,
} from "./types.ts";

const has = (flags: number, bit: number) => (flags & bit) !== 0;

type Action = PhisStoredPaymentOperation["record"]["action"];
/** What a consumer commands on an existing payment. `create` and `charge` bring one into being instead. */
type MutationAction = Exclude<Action, "create" | "charge">;
/** The grant an operation is resumed under: a charge is Core's own act, so reading it is what is asked. */
const grantedFor = (action: Action): PhisPaymentGrantedOperation => action === "charge" ? "read" : action;
type MutationInput = { paymentId: string; idempotencyKey: string; minor?: string; reason?: string };
/** The period of a subscription a payment settles; Core's own knowledge, never a consumer's argument. */
/** `changeId`: the payment is the one of a change's `due`, linked to it in the payment's own transaction. */
type PeriodLink = { subscriptionId: string; periodIndex: number; changeId?: string };
const ENDED_PAYMENT = ["failed", "expired", "canceled"];
type Options = {
  pool: Pool;
  scope: PhisPaymentScope;
  signal: AbortSignal;
  publicBaseUrl: () => Promise<string>;
  resolveProvider: (profile: PhisPaymentProfile) => Promise<PhisPaymentProviderV1>;
  merchantAuthorized: (action: "capture" | "cancel" | "refund" | "subscriptionEnd" | "subscriptionPrice" | "profileRefresh", policy: PhisPaymentMerchantActionPolicy) => Promise<boolean>;
  unauthenticated?: boolean;
  afterCommit?: () => Promise<unknown>;
  /**
   * The Add-ons that listen for `entitlement.changed`, asked only when an entry follows a subscription that
   * moved. Injected for the reason `providerFailed` is: the installed manifests are `server-only` and the CLI
   * loads this module too, where nobody is told (the expiry job still announces an ending).
   */
  entitlementListeners?: () => readonly string[];
  /**
   * Told what a Provider threw. The engine itself answers `provider_unavailable` or an unknown outcome,
   * which is right for the caller and said nothing to the operator; whoever constructs the engine
   * writes the failure where it logs. Not the engine, because the CLI loads this module too and the
   * server's log is `server-only`.
   */
  providerFailed?: (failure: PhisPaymentProviderFailure) => void;
  /** Told when a reconciliation observes again because a notification arrived while it held the payment. */
  reconcileRepeated?: (repeat: { siteId: number; consumerAddonId: string; paymentId: string; repeat: number; limit: number }) => void;
  /**
   * Whether the acting user holds the Site role Admin or Accountant (`listSettlements`); absent or false
   * without an acting user. Injected for the reason `providerFailed` is.
   */
  billingStaff?: () => Promise<boolean>;
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
  private readonly entitlementListeners = () => this.options.entitlementListeners?.() ?? [];
  private get pool() { return this.options.pool; }
  private get scope() { return this.options.scope; }
  private signal() { return AbortSignal.any([this.options.signal, AbortSignal.timeout(PHIS_PAYMENT_CALL_TIMEOUT_MS)]); }

  private async profile(key: string, operation: PhisPaymentGrantedOperation, creating = false): Promise<PhisPaymentProfile> {
    if (this.options.unauthenticated) throw new PhisPaymentError("forbidden");
    const { profile, grant } = await this.granted(key, operation);
    if (creating && (!profile.enabled || profile.retired || !profile.probedAt || !profile.merchantIdentity)) throw new PhisPaymentError("profile_unavailable");
    if (operation === "capture" || operation === "cancel" || operation === "refund") {
      if (!await this.options.merchantAuthorized(operation, grant.merchantActions[operation])) throw new PhisPaymentError("forbidden");
    }
    return profile;
  }

  /**
   * The profile and this consumer's grant on it, where the grant holds the operation; `not_found`
   * otherwise. Who is asking is not judged here: that is `profile`'s, and `profileReach`'s own.
   */
  private async granted(key: string, operation: PhisPaymentGrantedOperation) {
    const profile = await readPhisPaymentProfile(this.pool, this.scope.siteId, key);
    const grant = profile?.grants.find(g => g.consumerAddonId === this.scope.consumerAddonId);
    if (!profile || !grant?.operations.includes(operation)) throw new PhisPaymentError("not_found");
    return { profile, grant };
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
      // A pending change already says what the next period costs; the price waits until it is applied or void.
      if (current.record.status === "canceled" || current.record.status === "pending" || current.record.pendingChange) throw new PhisPaymentError("invalid_state");
      if (current.record.recurring.amount.currency !== recurring.amount.currency) throw new PhisPaymentError("invalid_input");
      // What the stored method was stored to carry still bounds what it can be charged under `automatic`.
      const method = current.record.collection.mode === "automatic" && current.record.storedMethodId
        ? await readPhisPaymentStoredMethod(db, this.scope.siteId, current.record.storedMethodId, this.scope.consumerAddonId) : null;
      if (method && (!method.features.stored || !phisPaymentMethodSupports(method.features.stored.pricing, phisPaymentPricingSelector(recurring.pricing)))) throw new PhisPaymentError("unsupported_operation");
      if (isDeepStrictEqual(current.record.recurring, recurring)) return current.record;
      current.record.recurring = recurring; current.record.version += 1;
      await writePhisPaymentSubscription(db, current, null, this.entitlementListeners);
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
          await writePhisPaymentSubscription(db, subscription, null, this.entitlementListeners);
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
  /**
   * The profiles this consumer may read, for a seller to choose one by: the grant rule of `granted`, in
   * one read, and refused to a hook as every operation but `profileFeatures` and `chooseCollection` is.
   */
  async listProfiles(): Promise<readonly PhisPaymentProfileSummary[]> {
    if (this.options.unauthenticated) throw new PhisPaymentError("forbidden");
    return listPhisPaymentProfilesGrantedTo(this.pool, this.scope.siteId, this.scope.consumerAddonId);
  }

  /** The profile under `read` for a hook-safe question: enabled and not retired, whoever asks. */
  private async recorded(profileKey: unknown, currency: unknown) {
    requirePhisPaymentReference(profileKey);
    const code = requirePhisPaymentCurrency(currency);
    const { profile } = await this.granted(profileKey, "read");
    if (!profile.enabled || profile.retired) throw new PhisPaymentError("profile_unavailable");
    return readPhisPaymentProfileFeatures(profile, code);
  }

  /**
   * What the profile can do in one currency, per pricing policy, read from what Core recorded; no Provider
   * is asked. One of the two operations a hook may call -- the ban `profile` applies to an unauthenticated
   * caller is not applied here and in `chooseCollection` -- because its answer names what the Provider can
   * do and nothing of a payment, a customer or the merchant's account.
   */
  async profileFeatures(input: Parameters<PhisPaymentsCapabilityV1["profileFeatures"]>[0]): Promise<PhisPaymentProfileFeatures | null> {
    return this.recorded(input?.profileKey, input?.currency);
  }

  /** The collection mode a subscription would get there, from the recording only (`choosePhisPaymentCollection`). */
  async chooseCollection(input: Parameters<PhisPaymentsCapabilityV1["chooseCollection"]>[0]): Promise<{ mode: PhisPaymentCollectionMode; features: PhisPaymentIntervalFeatures } | null> {
    const recording = await this.recorded(input?.profileKey, input?.currency);
    const pricing = validatePhisPaymentPricingSelector(input.pricing);
    const interval = validatePhisPaymentInterval(input.interval);
    if (!Array.isArray(input.modes) || input.modes.length > 3 || input.modes.some(mode => !["automatic", "payment-request", "provider-managed"].includes(mode))) {
      throw new PhisPaymentError("invalid_input");
    }
    return choosePhisPaymentCollection(recording, pricing, interval, input.modes);
  }

  /**
   * Asks the Provider again in each currency, once per pricing policy its methods declare, and records
   * every answer, as `phis payment profile probe` does. A merchant's act under
   * `merchantActions.profileRefresh`, and at most once a minute per profile, counted from the last time Core
   * asked it anything (`claimPhisPaymentProfileRefresh`). A currency answered before a later one fails stays
   * recorded: it is what the Provider said.
   */
  async refreshProfileFeatures(input: Parameters<PhisPaymentsCapabilityV1["refreshProfileFeatures"]>[0]): Promise<readonly PhisPaymentProfileFeatures[]> {
    requirePhisPaymentReference(input?.profileKey);
    if (!Array.isArray(input.currencies) || input.currencies.length === 0 || input.currencies.length > PHIS_PAYMENT_REACH_MAX_CURRENCIES) throw new PhisPaymentError("invalid_input");
    const currencies = input.currencies.map(requirePhisPaymentCurrency);
    if (new Set(currencies).size !== currencies.length) throw new PhisPaymentError("invalid_input");
    const profile = await this.profile(input.profileKey, "read");
    const policy = profile.grants.find(g => g.consumerAddonId === this.scope.consumerAddonId)!.merchantActions.profileRefresh;
    if (!policy || !await this.options.merchantAuthorized("profileRefresh", policy)) throw new PhisPaymentError("forbidden");
    if (!profile.enabled || profile.retired || !profile.merchantIdentity) throw new PhisPaymentError("profile_unavailable");
    const claim = await claimPhisPaymentProfileRefresh(this.pool, profile, PHIS_PAYMENT_REACH_REFRESH_SECONDS);
    if (claim !== "claimed") throw new PhisPaymentError(claim === "rate_limited" ? "rate_limited" : "profile_unavailable");
    let provider: PhisPaymentProviderV1;
    try { provider = await this.options.resolveProvider(profile); }
    catch (error) {
      if (error instanceof PhisPaymentError) throw error;
      this.providerFailed("probe", error, { profileKey: profile.key });
      throw new PhisPaymentError("provider_unavailable");
    }
    const recordings: PhisPaymentProfileFeatures[] = [];
    for (const currency of currencies) {
      let probed;
      try { probed = await probePhisPaymentProfileCurrency(provider, profile, currency, () => this.signal()); }
      catch (error) {
        if (error instanceof PhisPaymentError) throw error;
        this.providerFailed("probe", error, { profileKey: profile.key });
        throw new PhisPaymentError("provider_unavailable");
      }
      recordings.push(await recordPhisPaymentProfileFeatures(this.pool, profile, probed.merchantIdentity, probed.mode, currency, probed.policies));
    }
    return recordings;
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
    // For a recurring use only what can collect a subscription in a mode Core runs: `automatic` with a stored
    // method, or `payment-request`. Which mode and interval is the caller's to judge (`phisPaymentMethodCollects`);
    // how a method is stored is `stored.setup`, and what a later charge may carry is `stored.pricing`, judged then.
    return normalized.methods.filter(m => m.features.captureModes.includes(input.captureMode) && m.features.checkoutKinds.includes(input.checkoutKind)
      && phisPaymentMethodSupports(m.features.pricing, input.pricing)
      && (input.usage !== "recurring" || (!!m.features.stored && !!m.features.collection?.automatic) || !!m.features.collection?.paymentRequest))
      .map(method => ({ ...method, profileKey: profile.key }));
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
    const expiresAt = validatePhisPaymentExpiresAt(input.expiresAt);
    const documents = this.validateDocumentOwner(input.documentSubject, input.documentLabel);
    const profile = await this.profile(input.profileKey, "create");
    // Storing a method is a right of its own: a grant to take a payment does not include keeping the means.
    if (store) await this.profile(input.profileKey, "method-store");
    const request = { profileKey: input.profileKey, reference: input.reference, amount: { currency: input.amount.currency, minor: input.amount.minor }, pricing,
      description: input.description, captureMode: input.captureMode, methodKey: input.methodKey, checkoutKind: input.checkoutKind, returnPath: input.returnPath,
      ...(store ? { store } : {}), ...(expiresAt ? { expiresAt } : {}),
      ...(documents.subject !== null ? { documentSubject: documents.subject } : {}), ...(documents.label !== null ? { documentLabel: documents.label } : {}) };
    // Idempotent retries are checked before a live availability probe; completed requests do not depend on the PSP answering.
    const previous = await withPoolTransaction(this.pool, db => findPhisPaymentIdempotency(db, this.scope, "create", input.idempotencyKey));
    if (previous) {
      if (!isDeepStrictEqual(previous.request, request)) throw new PhisPaymentError("idempotency_conflict");
      return this.resume(previous.record.id);
    }
    if (!profile.enabled || profile.retired || !profile.probedAt || !profile.merchantIdentity) throw new PhisPaymentError("profile_unavailable");
    // Judged here and not with the format: a retry of a payment already made is answered after its end too.
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new PhisPaymentError("invalid_input");
    const baseUrl = await this.options.publicBaseUrl();
    const id = randomUUID();
    const returnUrl = phisPaymentReturnUrl(baseUrl, input.returnPath, id);
    const available = await this.methods(profile, { amount: request.amount, captureMode: input.captureMode, checkoutKind: input.checkoutKind, pricing: phisPaymentPricingSelector(pricing),
      ...(store ? { usage: "recurring" as const } : {}) });
    const method = available.find(m => m.methodKey === input.methodKey);
    if (!method || (store && !method.features.stored?.setup.includes("with-payment"))) throw new PhisPaymentError("method_unavailable");
    if (expiresAt) {
      // An end the method cannot keep is refused, never moved: the consumer decided it for a reason of its own.
      const bounds = method.features.checkoutExpiry;
      if (!bounds) throw new PhisPaymentError("unsupported_operation");
      const seconds = (Date.parse(expiresAt) - Date.now()) / 1000;
      if (seconds < bounds.minSeconds || seconds > bounds.maxSeconds) throw new PhisPaymentError("invalid_input");
    }
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
      binding: null, generation: 0, leaseToken: null, leaseUntil: null, notifiedGeneration: null,
      documentSubject: documents.subject, documentLabel: documents.label,
      record: { id, reference: input.reference, profileKey: profile.key, mode: profile.mode, amount: request.amount, pricing, totals: null, captureMode: input.captureMode,
        status: "created", authorizedMinor: "0", capturedMinor: "0", refundedMinor: "0", authorizationExpiresAt: null,
        checkout: null, flags: PhisPaymentFlag.ReconciliationRequired, version: 1, lastObservedAt: null, initiator: "customer", storedMethodId: storedMethod?.record.id ?? null,
        subscriptionId: link?.subscriptionId ?? null, periodIndex: link?.periodIndex ?? null },
    };
    const operation: PhisStoredPaymentOperation = {
      record: { id: operationId, paymentId: id, action: "create", state: "reserved", errorCode: null }, request,
      command: { action: "create", operationId, paymentId: id, providerIdempotencyKey: operationId, amount: request.amount, pricing,
        description: input.description, captureMode: input.captureMode, methodKey: input.methodKey, checkoutKind: input.checkoutKind, returnUrl, notificationUrl,
        ...(store ? { store } : {}), ...(expiresAt ? { expiresAt } : {}) },
    };
    const reservation = await withPoolTransaction(this.pool, async db => {
      const found = await findPhisPaymentIdempotency(db, this.scope, "create", input.idempotencyKey);
      if (found) { if (!isDeepStrictEqual(found.request, request)) throw new PhisPaymentError("idempotency_conflict"); return found; }
      await this.checkProfileRevision(db, profile, "create");
      await insertPhisPayment(db, payment); await insertPhisPaymentOperation(db, this.scope, input.idempotencyKey, operation);
      if (storedMethod) await insertPhisPaymentStoredMethod(db, storedMethod);
      if (link) await this.notePeriodPayment(db, link, id, false);
      if (link?.changeId) await this.linkChangePayment(db, link, id);
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
    documentSubject?: string | null; documentLabel?: string | null;
  }): Promise<PhisPaymentCommandResult> {
    input = structuredClone(input);
    const exponent = validatePhisPaymentMoney(input.amount);
    requirePhisPaymentReference(input.reference); requirePhisPaymentReference(input.idempotencyKey);
    if (typeof input.description !== "string" || input.description.length < 1 || input.description.length > 200
      || (input.initiator !== "merchant" && input.initiator !== "schedule")) throw new PhisPaymentError("invalid_input");
    const pricing = validatePhisPaymentPricing(input.pricing, input.amount);
    const documents = this.validateDocumentOwner(input.documentSubject, input.documentLabel);
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
      binding: null, generation: 0, leaseToken: null, leaseUntil: null, notifiedGeneration: null,
      documentSubject: documents.subject, documentLabel: documents.label,
      record: { id, reference: input.reference, profileKey: profile.key, mode: profile.mode, amount: request.amount, pricing, totals: null, captureMode: "automatic",
        status: "created", authorizedMinor: "0", capturedMinor: "0", refundedMinor: "0", authorizationExpiresAt: null,
        checkout: null, flags: PhisPaymentFlag.ReconciliationRequired, version: 1, lastObservedAt: null, initiator: input.initiator, storedMethodId: method.record.id,
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

  /**
   * Whose documents a payment's are and their list line (`billing:v1`): a subject reference as
   * `entitlements:v1` hands it out, or nobody's; a line of text, or the payment's description.
   */
  private validateDocumentOwner(subject: unknown, label: unknown): { subject: string | null; label: string | null } {
    if (subject !== undefined && subject !== null) requirePhisPaymentReference(subject);
    if (label !== undefined && label !== null && (typeof label !== "string" || label.length < 1 || label.length > 200 || /[\x00-\x1f\x7f]/.test(label))) {
      throw new PhisPaymentError("invalid_input");
    }
    return { subject: (subject as string | null | undefined) ?? null, label: (label as string | null | undefined) ?? null };
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

  /** How the periods after the first are paid, as a consumer states it; `provider-managed` is not built. */
  private validateCollection(value: unknown, interval: PhisPaymentInterval, graceDays: number): PhisPaymentCollection {
    const collection = value as PhisPaymentCollection | null;
    if (!collection || typeof collection !== "object" || Array.isArray(collection)) throw new PhisPaymentError("invalid_input");
    if (collection.mode === "provider-managed") throw new PhisPaymentError("unsupported_operation");
    if (collection.mode === "automatic") {
      if (Object.keys(collection).some(key => key !== "mode" && key !== "dunning")) throw new PhisPaymentError("invalid_input");
      return { mode: "automatic", dunning: validatePhisPaymentDunningPolicy(collection.dunning, graceDays) };
    }
    if (collection.mode === "payment-request") {
      if (Object.keys(collection).some(key => key !== "mode" && key !== "leadDays")) throw new PhisPaymentError("invalid_input");
      return { mode: "payment-request", leadDays: validatePhisPaymentDays(collection.leadDays, interval, PHIS_PAYMENT_LEAD_MAX_DAYS) };
    }
    throw new PhisPaymentError("invalid_input");
  }

  /** The boundary at the end of period `index`, from the current term's start. */
  private periodEnd(subscription: PhisStoredPaymentSubscription, index: number): string {
    return addPhisPaymentIntervals(new Date(subscription.anchorAt!), subscription.record.interval, index - subscription.termFirstIndex + 1).toISOString();
  }

  /** When Core next acts for a subscription whose latest paid period ends at `endsAt`: the renewal, or the request date. */
  private nextAfterPaid(record: PhisPaymentSubscription, endsAt: string): string {
    return record.collection.mode === "payment-request" ? addPhisPaymentDays(new Date(endsAt), -record.collection.leadDays).toISOString() : endsAt;
  }

  /**
   * The next moment of a requested period under `payment-request` that has not been said: the reminder
   * (3 days before its start, where that lies after the request), the end of the paid period, the day
   * before the grace ends (where the grace is at least 2 days), and the end of the grace.
   */
  private nextMoment(record: PhisPaymentSubscription, period: PhisStoredPaymentSubscriptionPeriod): string {
    const startsAt = new Date(period.record.startsAt);
    const said = (moment: keyof typeof PHIS_PAYMENT_PERIOD_MOMENT_FLAG) => has(period.moments, PHIS_PAYMENT_PERIOD_MOMENT_FLAG[moment]);
    const reminder = addPhisPaymentDays(startsAt, -PHIS_PAYMENT_REMINDER_DAYS);
    if (!said("reminder") && !said("due") && period.record.requestedAt && reminder > new Date(period.record.requestedAt)) return reminder.toISOString();
    if (!said("due")) return startsAt.toISOString();
    if (record.graceDays >= 2 && !said("grace-ending")) return addPhisPaymentDays(new Date(period.record.graceEndsAt), -1).toISOString();
    return period.record.graceEndsAt;
  }

  /**
   * The agreement first, as `pending`, then its first payment, which is an ordinary hosted payment and,
   * under `automatic`, also stores the method. What happens to that payment decides the rest: captured, the
   * subscription is active and its first term runs from then; ended without a capture, it is canceled.
   */
  async createSubscription(input: PhisPaymentSubscriptionCreateInput): Promise<PhisPaymentSubscriptionResult> {
    input = structuredClone(input);
    requirePhisPaymentReference(input.profileKey); requirePhisPaymentReference(input.reference); requirePhisPaymentReference(input.idempotencyKey);
    requirePhisPaymentReference(input.payerReference);
    // Period payments are referenced as `<reference>#<index>`, which has to stay a reference itself.
    if (input.reference.length > 200 || (input.methodKey !== null && (typeof input.methodKey !== "string" || input.methodKey.length > 255))) throw new PhisPaymentError("invalid_input");
    this.validateFlow("automatic", input.checkoutKind);
    const interval = validatePhisPaymentInterval(input.interval);
    const graceDays = validatePhisPaymentDays(input.graceDays, interval, PHIS_PAYMENT_GRACE_MAX_DAYS);
    const collection = this.validateCollection(input.collection, interval, graceDays);
    const recurring = this.validateTerms(input.recurring);
    const first = this.validateTerms(input.first);
    if (recurring.amount.currency !== first.amount.currency) throw new PhisPaymentError("invalid_input");
    const documents = this.validateDocumentOwner(input.documentSubject, input.documentLabel);
    const automatic = collection.mode === "automatic";
    const profile = await this.profile(input.profileKey, "subscription-create");
    const request = { profileKey: input.profileKey, reference: input.reference, payerReference: input.payerReference, interval, recurring, first, collection, graceDays,
      methodKey: input.methodKey, checkoutKind: input.checkoutKind, returnPath: input.returnPath,
      ...(documents.subject !== null ? { documentSubject: documents.subject } : {}), ...(documents.label !== null ? { documentLabel: documents.label } : {}) };
    const firstPayment = (id: string) => this.createPayment({ profileKey: input.profileKey, reference: `${input.reference}#0`, idempotencyKey: `subscription:${id}:first`,
      amount: first.amount, pricing: first.pricing, description: first.description, captureMode: "automatic", methodKey: input.methodKey,
      checkoutKind: input.checkoutKind, returnPath: input.returnPath, store: automatic ? { payerReference: input.payerReference } : null,
      documentSubject: documents.subject, documentLabel: documents.label }, { subscriptionId: id, periodIndex: 0 });

    const previous = await withPoolTransaction(this.pool, db => findPhisPaymentSubscriptionIdempotency(db, this.scope, input.idempotencyKey));
    if (previous) {
      if (!isDeepStrictEqual(previous.request, request)) throw new PhisPaymentError("idempotency_conflict");
      const payment = await firstPayment(previous.record.id);
      return { subscription: (await readPhisPaymentSubscription(this.pool, this.scope.siteId, previous.record.id, this.scope.consumerAddonId))!.record, payment };
    }
    if (!profile.enabled || profile.retired || !profile.probedAt || !profile.merchantIdentity) throw new PhisPaymentError("profile_unavailable");
    // Before anything is stored: the method has to collect in the mode asked for this interval, and be able
    // to carry what a renewal costs -- stored and charged without the customer, or on each period's checkout.
    const available = await this.methods(profile, { amount: first.amount, captureMode: "automatic", checkoutKind: input.checkoutKind,
      pricing: phisPaymentPricingSelector(first.pricing), usage: "recurring" });
    const method = available.find(m => m.methodKey === input.methodKey);
    if (!method) throw new PhisPaymentError("method_unavailable");
    if (!phisPaymentMethodCollects(method.features, collection.mode, interval)) throw new PhisPaymentError("unsupported_operation");
    const carries = automatic ? method.features.stored!.pricing : method.features.pricing;
    if (!phisPaymentMethodSupports(carries, phisPaymentPricingSelector(recurring.pricing))) throw new PhisPaymentError("unsupported_operation");

    const subscription: PhisStoredPaymentSubscription = {
      siteId: this.scope.siteId, consumerAddonId: this.scope.consumerAddonId, request, anchorAt: null, termFirstIndex: 0, leaseToken: null,
      record: { id: randomUUID(), reference: input.reference, profileKey: profile.key, mode: profile.mode, payerReference: input.payerReference, storedMethodId: null,
        interval, recurring, collection, graceDays, status: "pending", flags: 0, period: null, term: null, nextChargeAt: null, pendingChange: null, endedAt: null, version: 1 },
    };
    const raced = await withPoolTransaction(this.pool, async db => {
      const found = await findPhisPaymentSubscriptionIdempotency(db, this.scope, input.idempotencyKey);
      if (found) { if (!isDeepStrictEqual(found.request, request)) throw new PhisPaymentError("idempotency_conflict"); return found; }
      if (!await insertPhisPaymentSubscription(db, subscription, input.idempotencyKey)) throw new PhisPaymentError("active_attempt_exists");
      await writePhisPaymentSubscription(db, subscription, null, this.entitlementListeners);
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

  /** Whose documents a subscription's payments are, as its request stated. */
  private subscriptionDocuments(subscription: PhisStoredPaymentSubscription): { documentSubject: string | null; documentLabel: string | null } {
    const { documentSubject, documentLabel } = subscription.request as { documentSubject?: string; documentLabel?: string };
    return { documentSubject: documentSubject ?? null, documentLabel: documentLabel ?? null };
  }

  /**
   * Voids the subscription's pending change, under its row lock, and answers its id; `null` where none was
   * pending. The payment of an awaiting change is not cancelled here: what such a payment captures later
   * changes nothing, and the consumer learns of it from the payment's own event.
   */
  private async voidPendingChange(db: PoolClient, subscription: PhisStoredPaymentSubscription, only?: PhisPaymentSubscriptionChange["status"]): Promise<string | null> {
    const pending = subscription.record.pendingChange;
    if (!pending || (only && pending.status !== only)) return null;
    const change = await readPhisPaymentSubscriptionChange(db, subscription.record.id, pending.id, true);
    if (change && (change.record.status === "scheduled" || change.record.status === "awaiting_payment")) {
      change.record.status = "void"; change.record.version += 1;
      await writePhisPaymentSubscriptionChange(db, change);
    }
    subscription.record.pendingChange = null;
    return pending.id;
  }

  /**
   * Applies a scheduled change at the boundary `startsAt`, before the period from there on is charged or
   * requested: a new term starts there, and the period costs the new terms. Answers the change, or `null`.
   */
  private async applyScheduledChange(db: PoolClient, subscription: PhisStoredPaymentSubscription, startsAt: string, index: number): Promise<PhisPaymentSubscriptionChange | null> {
    const pending = subscription.record.pendingChange;
    if (!pending || pending.status !== "scheduled") return null;
    const change = await readPhisPaymentSubscriptionChange(db, subscription.record.id, pending.id, true);
    subscription.record.pendingChange = null;
    if (!change || change.record.status !== "scheduled") return null;
    this.takeTerms(subscription, change.record, startsAt, index);
    Object.assign(change.record, { status: "applied", effectiveAt: startsAt, periodIndex: index });
    change.record.version += 1;
    await writePhisPaymentSubscriptionChange(db, change);
    return change.record;
  }

  /** The terms of a change, from period `index` on, starting a new term at `startsAt`. */
  private takeTerms(subscription: PhisStoredPaymentSubscription, change: PhisPaymentSubscriptionChange, startsAt: string, index: number) {
    const { record } = subscription;
    record.interval = structuredClone(change.interval);
    record.recurring = structuredClone(change.recurring);
    record.graceDays = change.graceDays;
    if (record.collection.mode === "payment-request" && change.leadDays !== null) record.collection = { mode: "payment-request", leadDays: change.leadDays };
    record.term = { startsAt, firstIndex: index };
    subscription.anchorAt = startsAt; subscription.termFirstIndex = index;
  }

  /** Ends a subscription under its row lock: nothing further is charged, an unpaid period is void, a pending change too. */
  private async endSubscription(db: PoolClient, subscription: PhisStoredPaymentSubscription, at: Date) {
    const openIndex = (subscription.record.period?.index ?? -1) + 1;
    const open = await readPhisPaymentSubscriptionPeriod(db, subscription.record.id, openIndex, true);
    // A period that already failed keeps saying so; only one still open becomes void.
    if (open && open.record.status === "open") { open.record.status = "void"; await writePhisPaymentSubscriptionPeriod(db, open); }
    const changeId = await this.voidPendingChange(db, subscription);
    Object.assign(subscription.record, { status: "canceled", endedAt: at.toISOString(), nextChargeAt: null, flags: 0 });
    subscription.record.version += 1;
    await writePhisPaymentSubscription(db, subscription, open ? openIndex : null, this.entitlementListeners, { changeId });
  }

  /**
   * At the period end is what a customer asks for, through the consumer: nothing more is charged or
   * requested and what was paid for is kept; a pending change is void. A subscription with nothing paid
   * ahead has no such end to wait for and ends at once. Ending a paid subscription at once is the
   * merchant's act, and refunds nothing by itself.
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
        if (!has(current.record.flags, PhisPaymentSubscriptionFlag.CancelAtPeriodEnd) || current.record.pendingChange) {
          const changeId = await this.voidPendingChange(db, current);
          current.record.flags |= PhisPaymentSubscriptionFlag.CancelAtPeriodEnd; current.record.version += 1;
          await writePhisPaymentSubscription(db, current, null, this.entitlementListeners, { changeId });
        }
      } else await this.endSubscription(db, current, new Date());
      return current.record;
    });
    await this.options.afterCommit?.().catch(() => {});
    return record;
  }

  /** Takes back a cancellation at the period end, until that end has come; a voided change does not come back. */
  async resumeSubscription(subscriptionId: string): Promise<PhisPaymentSubscription | null> {
    if (!await this.subscription(subscriptionId, "subscription-cancel")) return null;
    const record = await withPoolTransaction(this.pool, async db => {
      const current = (await readPhisPaymentSubscription(db, this.scope.siteId, subscriptionId, this.scope.consumerAddonId, true))!;
      if (current.record.status !== "active" || !has(current.record.flags, PhisPaymentSubscriptionFlag.CancelAtPeriodEnd)) throw new PhisPaymentError("invalid_state");
      current.record.flags &= ~PhisPaymentSubscriptionFlag.CancelAtPeriodEnd;
      // Waiting for the end only, the schedule may have put off the request; it is owed from its own date again.
      const open = await readPhisPaymentSubscriptionPeriod(db, current.record.id, current.record.period!.index + 1);
      if (!open) current.record.nextChargeAt = this.nextAfterPaid(current.record, current.record.period!.endsAt);
      current.record.version += 1;
      await writePhisPaymentSubscription(db, current, null, this.entitlementListeners);
      return current.record;
    });
    await this.options.afterCommit?.().catch(() => {});
    return record;
  }

  /**
   * The customer pays the open period themselves, on a checkout, until its grace ends: a `past_due` one in
   * every mode, and under `payment-request` also a requested one while the subscription is `active`. Under
   * `automatic` the checkout stores the method anew; it is the way back from "the customer has to return",
   * and from a subscription Core stopped trying to charge. Under `payment-request` nothing is stored.
   */
  async settleSubscription(input: Parameters<PhisPaymentsCapabilityV1["settleSubscription"]>[0]): Promise<PhisPaymentCommandResult> {
    requirePhisPaymentReference(input.idempotencyKey);
    const found = await this.subscription(input.subscriptionId, "subscription-cancel");
    if (!found) throw new PhisPaymentError("not_found");
    const { record } = found.subscription;
    const index = (record.period?.index ?? -1) + 1;
    const period = await readPhisPaymentSubscriptionPeriod(this.pool, record.id, index);
    const requested = record.collection.mode === "payment-request" && record.status === "active" && period?.record.status === "open";
    if ((record.status !== "past_due" && !requested) || !period || period.record.status !== "open") throw new PhisPaymentError("invalid_state");
    if (Date.now() >= Date.parse(period.record.graceEndsAt)) throw new PhisPaymentError("invalid_state");
    const automatic = record.collection.mode === "automatic";
    return this.createPayment({ profileKey: record.profileKey, reference: `${record.reference}#${index}`, idempotencyKey: `subscription:${record.id}:${index}:settle:${input.idempotencyKey}`,
      amount: period.record.amount, pricing: record.recurring.pricing, description: record.recurring.description, captureMode: "automatic", methodKey: input.methodKey,
      checkoutKind: input.checkoutKind, returnPath: input.returnPath, store: automatic ? { payerReference: record.payerReference } : null,
      ...this.subscriptionDocuments(found.subscription) }, { subscriptionId: record.id, periodIndex: index });
  }

  async replaceSubscriptionMethod(input: Parameters<PhisPaymentsCapabilityV1["replaceSubscriptionMethod"]>[0]): Promise<PhisPaymentSubscription | null> {
    const found = await this.subscription(input.subscriptionId, "subscription-cancel");
    if (!found) return null;
    // Only a subscription Core charges without the customer has a method to replace.
    if (found.subscription.record.collection.mode !== "automatic") throw new PhisPaymentError("unsupported_operation");
    const method = await this.storedMethod(input.storedMethodId, "method-read");
    if (!method) throw new PhisPaymentError("not_found");
    const record = await withPoolTransaction(this.pool, async db => {
      const current = (await readPhisPaymentSubscription(db, this.scope.siteId, input.subscriptionId, this.scope.consumerAddonId, true))!;
      const target = await readPhisPaymentStoredMethod(db, this.scope.siteId, input.storedMethodId, this.scope.consumerAddonId, true);
      if (current.record.status === "canceled" || current.record.status === "pending") throw new PhisPaymentError("invalid_state");
      if (!target || target.record.status !== "active" || target.record.payerReference !== current.record.payerReference
        || target.record.profileKey !== current.record.profileKey) throw new PhisPaymentError("stored_method_unavailable");
      const waiting = has(current.record.flags, PhisPaymentSubscriptionFlag.CustomerActionRequired);
      if (current.record.storedMethodId === target.record.id && !waiting) return current.record;
      current.record.storedMethodId = target.record.id;
      // With a method that may work, the schedule tries again at its next run instead of waiting out the grace.
      if (current.record.status === "past_due" && waiting) {
        current.record.flags &= ~PhisPaymentSubscriptionFlag.CustomerActionRequired; current.record.nextChargeAt = new Date().toISOString();
      }
      current.record.version += 1;
      await writePhisPaymentSubscription(db, current, null, this.entitlementListeners);
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
    const change = await findPhisPaymentSubscriptionChangeByPayment(db, payment.record.id, true);
    if (change) { await this.settleChangePayment(db, subscription, change, payment); return; }
    const { record } = subscription;
    const status = payment.record.status;
    const now = new Date();

    if (record.status === "pending") {
      if (index !== 0) return;
      if (status === "captured") {
        const startsAt = now.toISOString();
        const endsAt = addPhisPaymentIntervals(now, record.interval, 1).toISOString();
        await ensurePhisPaymentSubscriptionPeriod(db, { subscriptionId: record.id, index: 0, startsAt, endsAt, amount: payment.record.amount, status: "paid",
          paymentIds: [payment.record.id], requestedAt: null, graceEndsAt: addPhisPaymentDays(now, record.graceDays).toISOString(), changeId: null, endedEarlyAt: null });
        subscription.anchorAt = startsAt; subscription.termFirstIndex = 0;
        Object.assign(record, { status: "active", period: { index: 0, startsAt, endsAt }, term: { startsAt, firstIndex: 0 },
          storedMethodId: record.collection.mode === "automatic" ? payment.record.storedMethodId : null, nextChargeAt: this.nextAfterPaid(record, endsAt) });
      } else if (ENDED_PAYMENT.includes(status)) {
        Object.assign(record, { status: "canceled", endedAt: now.toISOString(), nextChargeAt: null });
      } else return;
      record.version += 1;
      await writePhisPaymentSubscription(db, subscription, 0, this.entitlementListeners);
      return;
    }

    const period = await readPhisPaymentSubscriptionPeriod(db, record.id, index, true);
    if (!period || period.record.status === "paid" || period.record.status === "void" || period.record.status === "failed"
      || index !== (record.period?.index ?? -1) + 1) return;
    if (status === "captured") {
      period.record.status = "paid";
      await writePhisPaymentSubscriptionPeriod(db, period);
      Object.assign(record, { status: "active", nextChargeAt: this.nextAfterPaid(record, period.record.endsAt),
        period: { index, startsAt: period.record.startsAt, endsAt: period.record.endsAt } });
      record.flags &= ~PhisPaymentSubscriptionFlag.CustomerActionRequired;
      // The customer paid on a checkout that stored a method: that is the one to charge from now on.
      if (record.collection.mode === "automatic" && payment.record.initiator === "customer" && payment.record.storedMethodId) record.storedMethodId = payment.record.storedMethodId;
    } else if (record.collection.mode === "automatic" && ENDED_PAYMENT.includes(status) && payment.record.initiator === "schedule" && period.record.status === "open"
      && period.record.paymentIds.at(-1) === payment.record.id) {
      const needsCustomer = errorCode === "customer_action_required" || errorCode === "stored_method_unavailable";
      const next = needsCustomer ? null : nextPhisPaymentDunningAttempt(new Date(period.record.startsAt), record.collection.dunning, period.attempts);
      const graceEndsAt = new Date(period.record.graceEndsAt);
      // A scheduled charge is made at the period's start or later, whatever clock observed its answer.
      const dueAt = new Date(period.record.startsAt);
      const at = now < dueAt ? dueAt : now;
      // Retries lie within the grace; without one, the customer may still settle until the grace ends -- and with
      // a grace of 0 a declined renewal ends the subscription at once.
      if (!next && graceEndsAt <= at) { await this.failSubscriptionPeriod(db, subscription, index, at); return; }
      Object.assign(record, { status: "past_due", nextChargeAt: (next ?? graceEndsAt).toISOString() });
      if (needsCustomer) record.flags |= PhisPaymentSubscriptionFlag.CustomerActionRequired;
    } else return;
    record.version += 1;
    await writePhisPaymentSubscription(db, subscription, index, this.entitlementListeners);
  }

  /**
   * The schedule's turn at one subscription: what Core does on its own when `nextChargeAt` has come.
   *
   * Called by the scheduler under its lease, with this engine scoped to the subscription's consumer. It
   * decides under the row lock and charges outside it, and it never charges while an earlier payment for
   * the same period is unresolved: that one is asked about first, and the answer does the rest. Under
   * `payment-request` it charges nothing: it opens the period and says each moment once.
   */
  async advanceSubscription(subscriptionId: string, now = new Date()): Promise<{ postponed: unknown } | null> {
    const due = await withPoolTransaction(this.pool, async db => {
      const subscription = await readPhisPaymentSubscription(db, this.scope.siteId, subscriptionId, this.scope.consumerAddonId, true);
      const record = subscription?.record;
      if (!subscription || !record?.nextChargeAt || new Date(record.nextChargeAt) > now) return null;
      if ((record.status !== "active" && record.status !== "past_due") || !record.period) return null;
      const index = record.period.index + 1;
      const boundary = record.period.endsAt;
      const quietly = (until: string) => postponePhisPaymentSubscription(db, subscriptionId, new Date(until));
      const say = async (period: PhisStoredPaymentSubscriptionPeriod | null, fact: { changeId?: string | null; moment?: PhisPaymentSubscriptionMoment }) => {
        if (period) await writePhisPaymentSubscriptionPeriod(db, period);
        record.version += 1;
        await writePhisPaymentSubscription(db, subscription, period ? index : null, this.entitlementListeners, fact);
      };

      if (record.status === "active") {
        // A cancelled subscription ends with its paid period; nothing is charged or requested for the next.
        if (has(record.flags, PhisPaymentSubscriptionFlag.CancelAtPeriodEnd)) {
          if (now >= new Date(boundary)) await this.endSubscription(db, subscription, new Date(boundary));
          else await quietly(boundary);
          return null;
        }
        if (record.collection.mode === "automatic") {
          if (now < new Date(boundary)) { await quietly(boundary); return null; }
          // A renewal that falls due voids a change still awaiting its payment, and applies a scheduled one first.
          const voided = await this.voidPendingChange(db, subscription, "awaiting_payment");
          const applied = await this.applyScheduledChange(db, subscription, boundary, index);
          const period = await ensurePhisPaymentSubscriptionPeriod(db, { subscriptionId: record.id, index, startsAt: boundary,
            endsAt: this.periodEnd(subscription, index), amount: record.recurring.amount, status: "open", paymentIds: [], requestedAt: null,
            graceEndsAt: addPhisPaymentDays(new Date(boundary), record.graceDays).toISOString(), changeId: applied?.id ?? null, endedEarlyAt: null });
          if (voided || applied) await say(null, { changeId: applied?.id ?? voided });
          return { subscription, period, index };
        }
        const open = await readPhisPaymentSubscriptionPeriod(db, record.id, index, true);
        if (!open) {
          const requestAt = this.nextAfterPaid(record, boundary);
          if (now < new Date(requestAt)) { await quietly(requestAt); return null; }
          // The request is the period's start under `payment-request`: what applies to a renewal applies here.
          const voided = await this.voidPendingChange(db, subscription, "awaiting_payment");
          const applied = await this.applyScheduledChange(db, subscription, boundary, index);
          const period = await ensurePhisPaymentSubscriptionPeriod(db, { subscriptionId: record.id, index, startsAt: boundary,
            endsAt: this.periodEnd(subscription, index), amount: record.recurring.amount, status: "open", paymentIds: [], requestedAt: now.toISOString(),
            graceEndsAt: addPhisPaymentDays(new Date(boundary), record.graceDays).toISOString(), changeId: applied?.id ?? null, endedEarlyAt: null });
          period.moments |= PHIS_PAYMENT_PERIOD_MOMENT_FLAG.requested;
          record.flags |= PhisPaymentSubscriptionFlag.CustomerActionRequired;
          record.nextChargeAt = this.nextMoment(record, period);
          await say(period, { changeId: applied?.id ?? voided, moment: "requested" });
          return null;
        }
        if (open.record.status !== "open") return null;
        if (now >= new Date(boundary)) {
          open.moments |= PHIS_PAYMENT_PERIOD_MOMENT_FLAG.due;
          record.status = "past_due";
          record.nextChargeAt = this.nextMoment(record, open);
          await say(open, { moment: "due" });
        } else if (!has(open.moments, PHIS_PAYMENT_PERIOD_MOMENT_FLAG.reminder) && new Date(this.nextMoment(record, open)) <= now) {
          open.moments |= PHIS_PAYMENT_PERIOD_MOMENT_FLAG.reminder;
          record.nextChargeAt = this.nextMoment(record, open);
          await say(open, { moment: "reminder" });
        } else await quietly(this.nextMoment(record, open));
        return null;
      }

      const period = await readPhisPaymentSubscriptionPeriod(db, record.id, index, true);
      if (!period || period.record.status !== "open") return null;
      const graceEndsAt = new Date(period.record.graceEndsAt);
      if (record.collection.mode === "automatic") {
        const next = has(record.flags, PhisPaymentSubscriptionFlag.CustomerActionRequired) ? null
          : nextPhisPaymentDunningAttempt(new Date(period.record.startsAt), record.collection.dunning, period.attempts);
        // An attempt on the grace's last day is still made; after it, or without one, the grace's end is the end.
        if (next && next <= now) return { subscription, period, index };
        if (now >= graceEndsAt) { await this.failSubscriptionPeriod(db, subscription, index, now); return null; }
        await quietly((next && next < graceEndsAt ? next : graceEndsAt).toISOString());
        return null;
      }
      if (now >= graceEndsAt) { await this.failSubscriptionPeriod(db, subscription, index, now); return null; }
      if (record.graceDays >= 2 && !has(period.moments, PHIS_PAYMENT_PERIOD_MOMENT_FLAG["grace-ending"]) && addPhisPaymentDays(graceEndsAt, -1) <= now) {
        period.moments |= PHIS_PAYMENT_PERIOD_MOMENT_FLAG["grace-ending"];
        record.nextChargeAt = this.nextMoment(record, period);
        await say(period, { moment: "grace-ending" });
      } else await quietly(this.nextMoment(record, period));
      return null;
    });
    if (!due) { await this.options.afterCommit?.().catch(() => {}); return null; }
    const { subscription, period, index } = due;
    const { record } = subscription;

    const lastId = period.record.paymentIds.at(-1);
    const last = lastId ? await readPhisPayment(this.pool, this.scope.siteId, lastId, this.scope.consumerAddonId) : null;
    if (last && (has(last.record.flags, PhisPaymentFlag.ReconciliationRequired) || (last.record.status !== "captured" && !ENDED_PAYMENT.includes(last.record.status)))) {
      const profile = await readPhisPaymentProfile(this.pool, this.scope.siteId, record.profileKey);
      if (profile) await this.reconcile(last, profile).catch(() => {});
      return null;
    }
    const needsCustomer = () => withPoolTransaction(this.pool, async db => {
      const current = await readPhisPaymentSubscription(db, this.scope.siteId, subscriptionId, this.scope.consumerAddonId, true);
      if (!current || current.record.version !== record.version) return;
      const graceEndsAt = new Date(period.record.graceEndsAt);
      if (graceEndsAt <= now) { await this.failSubscriptionPeriod(db, current, index, now); return; }
      Object.assign(current.record, { status: "past_due", nextChargeAt: graceEndsAt.toISOString() });
      current.record.flags |= PhisPaymentSubscriptionFlag.CustomerActionRequired;
      current.record.version += 1;
      await writePhisPaymentSubscription(db, current, index, this.entitlementListeners);
    });
    try {
      if (!record.storedMethodId) throw new PhisPaymentError("stored_method_unavailable");
      await this.chargeStoredMethod({ storedMethodId: record.storedMethodId, reference: `${record.reference}#${index}`,
        idempotencyKey: `subscription:${record.id}:${index}:${period.attempts + 1}`, amount: period.record.amount, pricing: record.recurring.pricing,
        description: record.recurring.description, initiator: "schedule", subscription: { subscriptionId: record.id, periodIndex: index },
        ...this.subscriptionDocuments(subscription) });
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

  /** The grace of an unpaid period has ended: the period has failed, and the subscription ends (in every mode). */
  private async failSubscriptionPeriod(db: PoolClient, subscription: PhisStoredPaymentSubscription, index: number, now: Date) {
    const period = await readPhisPaymentSubscriptionPeriod(db, subscription.record.id, index, true);
    if (period && period.record.status === "open") { period.record.status = "failed"; await writePhisPaymentSubscriptionPeriod(db, period); }
    await this.endSubscription(db, subscription, now);
  }

  // ---- changes of terms (PAYMENTS.md, changes) ----

  /** A change request normalized against the subscription it changes: what stays, stays as it is. */
  private validateChangeRequest(input: PhisPaymentSubscriptionChangeRequest, record: PhisPaymentSubscription) {
    if (!input || typeof input !== "object" || (input.timing !== "now" && input.timing !== "period-end")) throw new PhisPaymentError("invalid_input");
    const interval = input.interval === undefined ? structuredClone(record.interval) : validatePhisPaymentInterval(input.interval);
    const recurring = this.validateTerms(input.recurring);
    if (recurring.amount.currency !== record.recurring.amount.currency) throw new PhisPaymentError("invalid_input");
    const graceDays = validatePhisPaymentDays(input.graceDays === undefined ? record.graceDays : input.graceDays, interval, PHIS_PAYMENT_GRACE_MAX_DAYS);
    let leadDays: number | null = null;
    if (record.collection.mode === "payment-request") {
      leadDays = validatePhisPaymentDays(input.leadDays === undefined ? record.collection.leadDays : input.leadDays, interval, PHIS_PAYMENT_LEAD_MAX_DAYS);
    } else if (input.leadDays !== undefined) throw new PhisPaymentError("invalid_input");
    // The retries of `automatic` lie within the grace, the new one as much as the old.
    if (record.collection.mode === "automatic" && record.collection.dunning.retryAfterDays.some(days => days > graceDays)) throw new PhisPaymentError("invalid_input");
    let oneTime: PhisPaymentSubscriptionTerms | null = null;
    if (input.oneTime !== undefined && input.oneTime !== null) {
      if (input.timing !== "now") throw new PhisPaymentError("invalid_input");
      oneTime = this.validateTerms(input.oneTime);
      if (oneTime.amount.currency !== recurring.amount.currency) throw new PhisPaymentError("invalid_input");
    }
    return { timing: input.timing, interval, recurring, graceDays, leadDays, oneTime };
  }

  /**
   * The unused share of what was paid ahead at `at`: every paid period that has not ended by then -- the
   * running one, and under `payment-request` a requested one paid early -- each by `phisPaymentUnusedShare`
   * of what it was charged under less what was refunded of its payment.
   */
  private async unusedCredit(db: Pick<PoolClient, "query">, subscription: PhisStoredPaymentSubscription, at: Date): Promise<bigint> {
    const { record } = subscription;
    if (!record.period) return BigInt(0);
    let credit = BigInt(0);
    for (let index = record.period.index; index >= 0 && index >= record.period.index - 1; index -= 1) {
      const period = await readPhisPaymentSubscriptionPeriod(db, record.id, index);
      if (!period || period.record.status !== "paid" || new Date(period.record.endedEarlyAt ?? period.record.endsAt) <= at) break;
      // Period 0 was paid under `first`, which may hold a one-time part; what counts is the recurring amount of then.
      const base = BigInt(index === 0 ? (subscription.request as { recurring: PhisPaymentSubscriptionTerms }).recurring.amount.minor : period.record.amount.minor);
      const payment = period.record.paymentIds.length ? await readPhisPayment(db, this.scope.siteId, period.record.paymentIds.at(-1)!) : null;
      const refunded = BigInt(payment?.record.refundedMinor ?? "0");
      const paid = base > refunded ? base - refunded : BigInt(0);
      credit += phisPaymentUnusedShare(paid, new Date(period.record.startsAt), new Date(period.record.endsAt), at);
      if (new Date(period.record.startsAt) <= at) break;
    }
    return credit;
  }

  /** Whether the subscription may change now: active, not ending, nothing pending and no period open. */
  private async requireChangeable(db: Pick<PoolClient, "query">, subscription: PhisStoredPaymentSubscription) {
    const { record } = subscription;
    if (record.status !== "active" || !record.period || has(record.flags, PhisPaymentSubscriptionFlag.CancelAtPeriodEnd) || record.pendingChange) {
      throw new PhisPaymentError("invalid_state");
    }
    const open = await readPhisPaymentSubscriptionPeriod(db, record.id, record.period.index + 1);
    if (open?.record.status === "open") throw new PhisPaymentError("invalid_state");
  }

  /** What a change would cost at `at`, by the one rule (`PhisPaymentSubscriptionChangeQuote`). */
  private async quote(db: Pick<PoolClient, "query">, subscription: PhisStoredPaymentSubscription, change: ReturnType<PhisPaymentEngine["validateChangeRequest"]>, at: Date): Promise<PhisPaymentSubscriptionChangeQuote> {
    await this.requireChangeable(db, subscription);
    const { record } = subscription;
    const currency = record.recurring.amount.currency;
    const zero = { currency, minor: "0" };
    // Under `automatic` the next periods are charged to the stored method, which bounds what they may carry.
    if (record.collection.mode === "automatic" && record.storedMethodId) {
      const method = await readPhisPaymentStoredMethod(db, this.scope.siteId, record.storedMethodId, this.scope.consumerAddonId);
      if (!method?.features.stored || !phisPaymentMethodSupports(method.features.stored.pricing, phisPaymentPricingSelector(change.recurring.pricing))) {
        throw new PhisPaymentError("unsupported_operation");
      }
    }
    if (change.timing === "period-end") {
      const startsAt = new Date(record.period!.endsAt);
      return { timing: "period-end", effectiveAt: startsAt.toISOString(), credit: zero, charge: { ...change.recurring.amount }, due: zero,
        period: { startsAt: startsAt.toISOString(), endsAt: addPhisPaymentIntervals(startsAt, change.interval, 1).toISOString() } };
    }
    const credit = await this.unusedCredit(db, subscription, at);
    const charge = BigInt(change.recurring.amount.minor) + BigInt(change.oneTime?.amount.minor ?? "0");
    // A credit beyond the new period is a downgrade, which goes at the period end; no balance is kept.
    if (credit > charge) throw new PhisPaymentError("invalid_input");
    requirePhisPaymentMinor(charge.toString());
    return { timing: "now", effectiveAt: at.toISOString(), credit: { currency, minor: credit.toString() }, charge: { currency, minor: charge.toString() },
      due: { currency, minor: (charge - credit).toString() },
      period: { startsAt: at.toISOString(), endsAt: addPhisPaymentIntervals(at, change.interval, 1).toISOString() } };
  }

  async previewSubscriptionChange(input: PhisPaymentSubscriptionChangeRequest): Promise<PhisPaymentSubscriptionChangeQuote> {
    const found = await this.subscription(input?.subscriptionId, "subscription-change");
    if (!found) throw new PhisPaymentError("not_found");
    return this.quote(this.pool, found.subscription, this.validateChangeRequest(input, found.subscription.record), new Date());
  }

  /**
   * The pricing of a change's `due`: the new period's and the one-time part's, less the credit as a stated
   * discount, so that a policy with line items states what is paid; `final`/`none` where neither has lines.
   */
  private duePricing(recurring: PhisPaymentSubscriptionTerms, oneTime: PhisPaymentSubscriptionTerms | null, credit: string): PhisPaymentPricing {
    const lined = "lineItems" in recurring.pricing;
    if (oneTime && ("lineItems" in oneTime.pricing) !== lined) throw new PhisPaymentError("invalid_input");
    if (!("lineItems" in recurring.pricing)) return { basis: "final", tax: "none" };
    const base = recurring.pricing;
    const once = oneTime && "lineItems" in oneTime.pricing ? oneTime.pricing : null;
    if (once && (once.basis !== base.basis || once.tax !== base.tax || once.shipping !== null)) throw new PhisPaymentError("invalid_input");
    return {
      basis: base.basis, tax: base.tax, promotionCodes: base.promotionCodes, customer: base.customer, shipping: base.shipping,
      lineItems: [...base.lineItems, ...(once?.lineItems ?? []).map(line => ({ ...line, reference: `once:${line.reference}` }))],
      discounts: [...base.discounts, ...(once?.discounts ?? []).map(discount => ({ ...discount, reference: `once:${discount.reference}` })),
        ...(credit !== "0" ? [{ reference: "subscription-credit", label: "Credit for the unused part of the current period", minor: credit }] : [])],
    };
  }

  /** In the payment's reservation: the change knows its payment from the transaction that created it. */
  private async linkChangePayment(db: PoolClient, link: PeriodLink, paymentId: string) {
    const change = await readPhisPaymentSubscriptionChange(db, link.subscriptionId, link.changeId!, true);
    if (!change || change.record.status !== "awaiting_payment" || (change.record.paymentId !== null && change.record.paymentId !== paymentId)) throw new PhisPaymentError("invalid_state");
    if (change.record.paymentId === paymentId) return;
    change.record.paymentId = paymentId; change.record.version += 1;
    await writePhisPaymentSubscriptionChange(db, change);
    const subscription = (await readPhisPaymentSubscription(db, this.scope.siteId, link.subscriptionId, null, true))!;
    if (subscription.record.pendingChange?.id === change.record.id) {
      subscription.record.pendingChange = change.record;
      await writePhisPaymentSubscription(db, subscription, null, this.entitlementListeners, { changeId: change.record.id });
    }
  }

  /**
   * A change taking effect now, at `at`: the paid period ends there (`endedEarlyAt`), a new term starts with
   * a paid period under the new terms, and the renewal or request date moves to its end.
   */
  private async applyChangeNow(db: PoolClient, subscription: PhisStoredPaymentSubscription, change: PhisStoredPaymentSubscriptionChange, at: Date, payment: PhisStoredPayment | null) {
    const { record } = subscription;
    const index = record.period!.index + 1;
    for (let earlier = record.period!.index; earlier >= 0 && earlier >= record.period!.index - 1; earlier -= 1) {
      const period = await readPhisPaymentSubscriptionPeriod(db, record.id, earlier, true);
      if (!period || period.record.status !== "paid" || new Date(period.record.endsAt) <= at || period.record.endedEarlyAt) break;
      period.record.endedEarlyAt = at.toISOString();
      await writePhisPaymentSubscriptionPeriod(db, period);
    }
    this.takeTerms(subscription, change.record, at.toISOString(), index);
    const endsAt = addPhisPaymentIntervals(at, record.interval, 1).toISOString();
    await ensurePhisPaymentSubscriptionPeriod(db, { subscriptionId: record.id, index, startsAt: at.toISOString(), endsAt, amount: { ...change.record.recurring.amount },
      status: "paid", paymentIds: payment ? [payment.record.id] : [], requestedAt: null, graceEndsAt: addPhisPaymentDays(at, record.graceDays).toISOString(),
      changeId: change.record.id, endedEarlyAt: null });
    Object.assign(record, { status: "active", period: { index, startsAt: at.toISOString(), endsAt }, nextChargeAt: this.nextAfterPaid(record, endsAt), pendingChange: null });
    record.flags &= ~PhisPaymentSubscriptionFlag.CustomerActionRequired;
    // The payment of `due` stored the method anew under `automatic`: the subscription is charged to it from now on.
    if (record.collection.mode === "automatic" && payment?.record.storedMethodId) record.storedMethodId = payment.record.storedMethodId;
    Object.assign(change.record, { status: "applied", effectiveAt: at.toISOString(), periodIndex: index });
    change.record.version += 1;
    await writePhisPaymentSubscriptionChange(db, change);
    record.version += 1;
    await writePhisPaymentSubscription(db, subscription, index, this.entitlementListeners, { changeId: change.record.id });
  }

  /** What the payment of a change's `due` means for it: captured, it is applied; ended unpaid, it is void. */
  private async settleChangePayment(db: PoolClient, subscription: PhisStoredPaymentSubscription, change: PhisStoredPaymentSubscriptionChange, payment: PhisStoredPayment) {
    if (change.record.status !== "awaiting_payment") return;
    if (payment.record.status === "captured" && subscription.record.status === "active" && subscription.record.pendingChange?.id === change.record.id) {
      await this.applyChangeNow(db, subscription, change, new Date(), payment);
    } else if (ENDED_PAYMENT.includes(payment.record.status)) {
      const changeId = await this.voidPendingChange(db, subscription);
      if (!changeId) { change.record.status = "void"; change.record.version += 1; await writePhisPaymentSubscriptionChange(db, change); }
      subscription.record.version += 1;
      await writePhisPaymentSubscription(db, subscription, null, this.entitlementListeners, { changeId: change.record.id });
    }
  }

  private async changeResult(change: PhisStoredPaymentSubscriptionChange): Promise<PhisPaymentSubscriptionChangeResult> {
    const subscription = (await readPhisPaymentSubscription(this.pool, this.scope.siteId, change.record.subscriptionId, this.scope.consumerAddonId))!;
    const current = (await readPhisPaymentSubscriptionChange(this.pool, change.record.subscriptionId, change.record.id))!;
    const payment = current.record.paymentId ? await this.resumePaymentOf(current.record.paymentId) : null;
    return { subscription: subscription.record, change: current.record, payment };
  }

  /** The payment of a change's `due` with its create operation, as `create` would answer it again. */
  private async resumePaymentOf(paymentId: string): Promise<PhisPaymentCommandResult | null> {
    const operations = await listPhisPaymentOperations(this.pool, paymentId);
    const created = operations.find(operation => operation.record.action === "create");
    return created ? this.resume(created.record.id) : null;
  }

  async changeSubscription(input: Parameters<PhisPaymentsCapabilityV1["changeSubscription"]>[0]): Promise<PhisPaymentSubscriptionChangeResult> {
    input = structuredClone(input);
    requirePhisPaymentReference(input?.reference); requirePhisPaymentReference(input.idempotencyKey);
    // The payment of `due` is referenced as `<subscription>~<change>`, which has to stay a reference itself.
    if (input.reference.length > 40) throw new PhisPaymentError("invalid_input");
    validatePhisPaymentMoney(input.expectedDue, false);
    const found = await this.subscription(input.subscriptionId, "subscription-change");
    if (!found) throw new PhisPaymentError("not_found");
    const change = this.validateChangeRequest(input, found.subscription.record);
    let checkout: { methodKey: string | null; checkoutKind: "redirect"; returnPath: string; expiresAt: string | null } | null = null;
    if (change.timing === "now") {
      if (!input.checkout) throw new PhisPaymentError("invalid_input");
      this.validateFlow("automatic", input.checkout.checkoutKind);
      if (input.checkout.methodKey !== null && (typeof input.checkout.methodKey !== "string" || input.checkout.methodKey.length > 255)) throw new PhisPaymentError("invalid_input");
      checkout = { methodKey: input.checkout.methodKey, checkoutKind: "redirect", returnPath: input.checkout.returnPath, expiresAt: validatePhisPaymentExpiresAt(input.checkout.expiresAt) };
    }
    const request = { subscriptionId: input.subscriptionId, reference: input.reference, ...change, expectedDue: { currency: input.expectedDue.currency, minor: input.expectedDue.minor }, checkout };
    const previous = await withPoolTransaction(this.pool, db => findPhisPaymentSubscriptionChangeIdempotency(db, this.scope, input.idempotencyKey));
    if (previous) {
      if (!isDeepStrictEqual(previous.request, request)) throw new PhisPaymentError("idempotency_conflict");
      return this.changeResult(previous);
    }
    const at = new Date();
    const quoted = await this.quote(this.pool, found.subscription, change, at);
    if (quoted.due.currency !== input.expectedDue.currency) throw new PhisPaymentError("invalid_input");
    if (BigInt(quoted.due.minor) > BigInt(input.expectedDue.minor)) throw new PhisPaymentError("quote_outdated");
    const paying = change.timing === "now" && quoted.due.minor !== "0";
    const stored: PhisStoredPaymentSubscriptionChange = {
      siteId: this.scope.siteId, consumerAddonId: this.scope.consumerAddonId, request,
      record: { id: randomUUID(), subscriptionId: found.subscription.record.id, reference: input.reference, timing: change.timing,
        status: change.timing === "period-end" ? "scheduled" : paying ? "awaiting_payment" : "applied",
        interval: change.interval, recurring: change.recurring, graceDays: change.graceDays, leadDays: change.leadDays,
        credit: quoted.credit, charge: quoted.charge, due: quoted.due, effectiveAt: null, paymentId: null, periodIndex: null,
        createdAt: at.toISOString(), version: 1 },
    };
    const raced = await withPoolTransaction(this.pool, async db => {
      const existing = await findPhisPaymentSubscriptionChangeIdempotency(db, this.scope, input.idempotencyKey);
      if (existing) { if (!isDeepStrictEqual(existing.request, request)) throw new PhisPaymentError("idempotency_conflict"); return existing; }
      const current = (await readPhisPaymentSubscription(db, this.scope.siteId, found.subscription.record.id, this.scope.consumerAddonId, true))!;
      // Quoted outside the lock: anything that moved since asks for a new quote.
      if (current.record.version !== found.subscription.record.version) throw new PhisPaymentError("quote_outdated");
      await this.requireChangeable(db, current);
      const applied = stored.record.status === "applied";
      if (applied) stored.record.status = "awaiting_payment";
      if (!await insertPhisPaymentSubscriptionChange(db, stored, input.idempotencyKey)) throw new PhisPaymentError("idempotency_conflict");
      if (applied) { await this.applyChangeNow(db, current, stored, at, null); return null; }
      current.record.pendingChange = stored.record;
      current.record.version += 1;
      await writePhisPaymentSubscription(db, current, null, this.entitlementListeners, { changeId: stored.record.id });
      return null;
    });
    if (raced) return this.changeResult(raced);
    if (!paying) { await this.options.afterCommit?.().catch(() => {}); return this.changeResult(stored); }
    const { record } = found.subscription;
    try {
      await this.createPayment({ profileKey: record.profileKey, reference: `${record.reference}~${input.reference}`, idempotencyKey: `subscription-change:${stored.record.id}`,
        amount: quoted.due, pricing: this.duePricing(change.recurring, change.oneTime, quoted.credit.minor), description: change.recurring.description, captureMode: "automatic",
        methodKey: checkout!.methodKey, checkoutKind: checkout!.checkoutKind, returnPath: checkout!.returnPath, expiresAt: checkout!.expiresAt,
        store: record.collection.mode === "automatic" ? { payerReference: record.payerReference } : null, ...this.subscriptionDocuments(found.subscription) },
      { subscriptionId: record.id, periodIndex: record.period!.index + 1, changeId: stored.record.id });
    } catch (error) {
      // No payment came to exist, or none that can be paid: the change is void and nothing changed.
      await withPoolTransaction(this.pool, async db => {
        const current = (await readPhisPaymentSubscription(db, this.scope.siteId, record.id, this.scope.consumerAddonId, true))!;
        const pending = await readPhisPaymentSubscriptionChange(db, record.id, stored.record.id, true);
        if (pending?.record.status === "awaiting_payment" && pending.record.paymentId === null) {
          await this.voidPendingChange(db, current);
          current.record.version += 1;
          await writePhisPaymentSubscription(db, current, null, this.entitlementListeners, { changeId: stored.record.id });
        }
      });
      await this.options.afterCommit?.().catch(() => {});
      throw error;
    }
    return this.changeResult(stored);
  }

  async cancelSubscriptionChange(input: Parameters<PhisPaymentsCapabilityV1["cancelSubscriptionChange"]>[0]): Promise<PhisPaymentSubscriptionChange | null> {
    requirePhisPaymentReference(input?.changeId);
    const found = await this.subscription(input.subscriptionId, "subscription-change");
    if (!found) return null;
    const result = await withPoolTransaction(this.pool, async db => {
      const current = (await readPhisPaymentSubscription(db, this.scope.siteId, input.subscriptionId, this.scope.consumerAddonId, true))!;
      const change = await readPhisPaymentSubscriptionChange(db, input.subscriptionId, input.changeId, true);
      if (!change) return null;
      if (change.record.status !== "scheduled" && change.record.status !== "awaiting_payment") return { change: change.record, paymentId: null };
      const paymentId = change.record.paymentId;
      if (current.record.pendingChange?.id === change.record.id) await this.voidPendingChange(db, current);
      else { change.record.status = "void"; change.record.version += 1; await writePhisPaymentSubscriptionChange(db, change); }
      current.record.version += 1;
      await writePhisPaymentSubscription(db, current, null, this.entitlementListeners, { changeId: change.record.id });
      return { change: (await readPhisPaymentSubscriptionChange(db, input.subscriptionId, input.changeId))!.record, paymentId };
    });
    // Its checkout is ended where the method can be cancelled; what is paid anyway is the consumer's to refund.
    if (result?.paymentId) await this.mutate("cancel", { paymentId: result.paymentId, idempotencyKey: `subscription-change:${input.changeId}:cancel` }, true).catch(() => {});
    await this.options.afterCommit?.().catch(() => {});
    return result?.change ?? null;
  }

  async listSubscriptionChanges(subscriptionId: string): Promise<readonly PhisPaymentSubscriptionChange[]> {
    if (!await this.subscription(subscriptionId, "subscription-change")) return [];
    return listPhisPaymentSubscriptionChanges(this.pool, subscriptionId);
  }

  async subscriptionCredit(subscriptionId: string): Promise<{ credit: PhisPaymentMoney; at: string; periodIndex: number } | null> {
    const found = await this.subscription(subscriptionId, "subscription-change");
    const record = found?.subscription.record;
    if (!found || !record?.period || record.status === "pending" || record.status === "canceled") return null;
    const at = new Date();
    const credit = await this.unusedCredit(this.pool, found.subscription, at);
    return { credit: { currency: record.recurring.amount.currency, minor: credit.toString() }, at: at.toISOString(), periodIndex: record.period.index };
  }

  /**
   * What a payment and its refunds settled, oldest first: under the grant `settlement-read`, and only for an
   * acting user with the Site role Admin or Accountant -- never a Shop clerk or the customer.
   */
  async listSettlements(paymentId: string): Promise<readonly PhisPaymentSettlement[]> {
    if (this.options.unauthenticated || !await this.options.billingStaff?.()) throw new PhisPaymentError("forbidden");
    const found = await this.persisted(paymentId, "settlement-read");
    return found ? listPhisPaymentSettlements(this.pool, this.scope.siteId, found.payment.record.id) : [];
  }

  private async checkProfileRevision(db: PoolClient, expected: PhisPaymentProfile, action: PhisPaymentGrantedOperation) {
    const current = await readPhisPaymentProfile(db, this.scope.siteId, expected.key, true);
    if (!current || current.revision !== expected.revision || !current.grants.find(g => g.consumerAddonId === this.scope.consumerAddonId)?.operations.includes(action)) throw new PhisPaymentError("profile_unavailable");
  }

  complete(input: MutationInput) { return this.mutate("complete", input); }
  cancel(input: MutationInput) { return this.mutate("cancel", input); }
  capture(input: MutationInput & { minor: string }) { return this.mutate("capture", input); }
  refund(input: MutationInput & { minor: string; reason: string }) { return this.mutate("refund", input); }

  /**
   * `core`: Core's own act on a payment it made for a subscription (a change's checkout it ends), under no
   * consumer's merchant policy; every rule of the payment itself still holds.
   */
  private async mutate(action: MutationAction, input: MutationInput, core = false): Promise<PhisPaymentCommandResult> {
    input = structuredClone(input);
    requirePhisPaymentReference(input.paymentId); requirePhisPaymentReference(input.idempotencyKey);
    if (action === "capture" || action === "refund") requirePhisPaymentMinor(input.minor, true);
    if (action === "refund" && (typeof input.reason !== "string" || input.reason.length > 500)) throw new PhisPaymentError("invalid_input");
    const found = core ? await this.persisted(input.paymentId, "read") : await this.persisted(input.paymentId, action);
    if (!found) throw new PhisPaymentError("not_found");
    const request = { paymentId: input.paymentId, ...(action === "capture" || action === "refund" ? { minor: input.minor } : {}), ...(action === "refund" ? { reason: input.reason } : {}) };
    const result = await withPoolTransaction(this.pool, async db => {
      const previous = await findPhisPaymentIdempotency(db, this.scope, action, input.idempotencyKey);
      if (previous) { if (!isDeepStrictEqual(previous.request, request)) throw new PhisPaymentError("idempotency_conflict"); return { previous }; }
      await this.checkProfileRevision(db, found.profile, core ? "read" : action);
      const payment = (await readPhisPayment(db, this.scope.siteId, input.paymentId, this.scope.consumerAddonId, true))!;
      const operations = await listPhisPaymentOperations(db, input.paymentId);
      if (has(payment.record.flags, PhisPaymentFlag.ReconciliationRequired) || operations.some(o => ["reserved", "indeterminate"].includes(o.record.state))) throw new PhisPaymentError("reconciliation_required");
      if (!payment.binding || !await claimPhisPayment(db, payment)) throw new PhisPaymentError("invalid_state");
      const minor = input.minor;
      const features = payment.features.flags;
      if (action === "cancel" && !has(features, PhisPaymentFeatureFlag.Cancel)) throw new PhisPaymentError("unsupported_operation");
      if (action === "capture" && !payment.features.captureModes.includes("manual")) throw new PhisPaymentError("unsupported_operation");
      if (action === "capture" && !has(features, PhisPaymentFeatureFlag.PartialCapture) && input.minor !== payment.record.authorizedMinor) throw new PhisPaymentError("unsupported_operation");
      if (action === "refund" && !has(features, PhisPaymentFeatureFlag.Refund)) throw new PhisPaymentError("unsupported_operation");

      if (action === "capture" && (payment.record.captureMode !== "manual" || payment.record.status !== "authorized" || BigInt(minor!) > BigInt(payment.record.authorizedMinor))) throw new PhisPaymentError("invalid_state");
      if (action === "cancel" && !["awaiting_customer", "authorized"].includes(payment.record.status)) throw new PhisPaymentError("invalid_state");
      const refunds = await listPhisPaymentRefunds(db, input.paymentId);
      if (action === "refund") {
        const reserved = refunds.filter(r => ["pending", "succeeded"].includes(r.record.status)).reduce((sum, r) => sum + BigInt(r.record.amount.minor), BigInt(0));
        if (!has(features, PhisPaymentFeatureFlag.PartialRefund) && BigInt(minor!) !== BigInt(payment.record.capturedMinor) - reserved) throw new PhisPaymentError("unsupported_operation");
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
      payment.record.flags |= PhisPaymentFlag.ReconciliationRequired; payment.record.version += 1;
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
    let knocked: boolean;
    try { knocked = await this.apply(payment, profile, result, operation.record.id); }
    catch {
      // Invalid observations after submission preserve the durable operation and its reservation.
      knocked = await this.apply(payment, profile, { outcome: "unknown" }, operation.record.id);
    }
    await this.options.afterCommit?.().catch(() => {});
    // A notification arrived while this command held the payment: observe once more, after it. What this
    // cannot do now stays remembered for the maintenance run, and never changes the command's result.
    if (knocked) await this.reconcile(payment, profile).catch(() => {});
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
    await this.reconcileRounds(payment, profile, receipt, false);
  }

  /**
   * A verified notification. It is a knock: what it says Core reads from the Provider itself. When the payment is
   * held by another call, the knock is remembered on the payment (and the delivery's receipt finished with it, in
   * the same transaction) instead of refused, and the holder observes once more before it lets go.
   */
  async reconcileNotified(payment: PhisStoredPayment, profile: PhisPaymentProfile, receipt?: PhisPaymentReceipt): Promise<"reconciled" | "remembered"> {
    return this.reconcileRounds(payment, profile, receipt, true);
  }

  private async reconcileRounds(payment: PhisStoredPayment, profile: PhisPaymentProfile, receipt: PhisPaymentReceipt | undefined, remember: boolean): Promise<"reconciled" | "remembered"> {
    for (let repeat = 0; ; repeat += 1) {
      const claimed = await withPoolTransaction(this.pool, async db => {
        const locked = await readPhisPayment(db, payment.siteId, payment.record.id, null, true);
        if (locked && await claimPhisPayment(db, locked)) return locked;
        // After a knock the lease was let go; somebody holding it now claimed after the knock and observes after it.
        if (repeat > 0) return null;
        if (remember && locked && await rememberPhisPaymentNotification(db, locked)) {
          if (receipt) await finishPhisPaymentReceipt(db, payment.siteId, receipt);
          return "remembered" as const;
        }
        throw new PhisPaymentError("provider_unavailable");
      });
      if (claimed === "remembered") return "remembered";
      if (!claimed) return "reconciled";
      const knocked = await this.reconcileHeld(claimed, profile, repeat === 0 ? receipt : undefined);
      await this.options.afterCommit?.().catch(() => {});
      // Told during this claim: this observation may predate it. The knock stays set when the repeats run out,
      // and the maintenance run finds the payment.
      if (!knocked || repeat >= PHIS_PAYMENT_KNOCK_REPEATS) return "reconciled";
      this.options.reconcileRepeated?.({ siteId: claimed.siteId, consumerAddonId: claimed.consumerAddonId, paymentId: claimed.record.id, repeat: repeat + 1, limit: PHIS_PAYMENT_KNOCK_REPEATS });
    }
  }

  /** One observation under a claim; true when a notification was remembered during it. */
  private async reconcileHeld(claimed: PhisStoredPayment, profile: PhisPaymentProfile, receipt?: PhisPaymentReceipt): Promise<boolean> {
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
    try { return await this.apply(claimed, profile, result, operationId, receipt, true); }
    catch (error) { await this.apply(claimed, profile, { outcome: "unknown" }, operationId); throw error; }
  }

  private async apply(claimed: PhisStoredPayment, profile: PhisPaymentProfile, result: PhisPaymentProviderExecution, operationId: string | null, receipt?: PhisPaymentReceipt, observing = false): Promise<boolean> {
    if (!result || !["applied", "pending", "rejected", "unknown"].includes(result.outcome)
      || (result.outcome === "rejected" && !PHIS_PAYMENT_ERROR_CODES.includes(result.code))) throw new PhisPaymentError("provider_unavailable");
    return withPoolTransaction(this.pool, async db => {
      const payment = (await readPhisPayment(db, claimed.siteId, claimed.record.id, null, true))!;
      if (!payment || payment.generation !== claimed.generation || payment.leaseToken !== claimed.leaseToken) throw new PhisPaymentError("provider_unavailable");
      // Read under the row lock that also releases the lease below: a notification either is remembered here
      // already, or finds the payment unheld and reconciles it itself.
      const knocked = payment.notifiedGeneration !== null && payment.notifiedGeneration >= claimed.generation;
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
      if (operations.some(o => ["reserved", "indeterminate"].includes(o.record.state))) payment.record.flags |= PhisPaymentFlag.ReconciliationRequired;
      else payment.record.flags &= ~PhisPaymentFlag.ReconciliationRequired;
      const reportedMethod = (result.outcome === "applied" || result.outcome === "pending") && result.observation.storedMethod
        ? validatePhisPaymentProviderStoredMethod(result.observation.storedMethod) : null;
      // The method is part of what the consumer is told changed: it may become active after the capture.
      const methodChanged = await this.settleStoredMethod(db, payment, reportedMethod, result.outcome === "rejected" ? result.code : null);
      const comparable = { ...payment.record, lastObservedAt: before.lastObservedAt };
      const changed = methodChanged || !isDeepStrictEqual(before, comparable) || !isDeepStrictEqual(beforeOperations, operations.map(o => o.record)) || !isDeepStrictEqual(beforeRefunds, refunds.map(r => r.record));
      if (changed) payment.record.version += 1;
      await writePhisPayment(db, payment, changed ? { operationId, refundId: changedRefundId } : null);
      // What the Provider documents and settles for a capture or a succeeded refund is collected after it,
      // by the job, from a task written with the fact (PAYMENTS.md, records).
      const captured = before.status !== "captured" && payment.record.status === "captured";
      const refunded = refunds.filter(r => r.record.status === "succeeded" && beforeRefunds.find(b => b.id === r.record.id)?.status !== "succeeded");
      if (captured || refunded.length > 0) {
        await enqueuePhisPaymentRecordTasks(db, payment, [...(captured ? [null] : []), ...refunded.map(r => r.record.id)], {
          documents: !!payment.features.documents?.kinds.some(kind => has(kind.flags, PhisPaymentDocumentFeatureFlag.Fetchable)),
          settlements: has(payment.features.currency.flags, PhisPaymentCurrencyFeatureFlag.SettlementRecords),
        });
      }
      // In the payment's own transaction: the period is paid exactly when the payment says it is.
      if (payment.record.subscriptionId) await this.settleSubscriptionPayment(db, payment, operation?.record.errorCode ?? null);
      if (receipt) await finishPhisPaymentReceipt(db, payment.siteId, receipt);
      // This claim is newer than the knock it found and has now asked the Provider: the knock is answered.
      if (observing && (result.outcome === "applied" || result.outcome === "pending") && payment.notifiedGeneration !== null && !knocked) {
        await settlePhisPaymentNotification(db, payment.record.id, claimed.generation);
      }
      return knocked;
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
