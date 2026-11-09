import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type {
  PhisPaymentCommandResult, PhisPaymentCreateInput, PhisPaymentGrantedOperation, PhisPaymentMerchantActionPolicy,
  PhisPaymentProviderExecution, PhisPaymentProviderObservation, PhisPaymentProviderV1, PhisPaymentsCapabilityV1,
} from "@phis/contracts/payments";
import {
  claimPhisPayment, findPhisPaymentIdempotency, insertPhisPayment, insertPhisPaymentOperation,
  listPhisPaymentOperations, listPhisPaymentRefunds, readPhisPayment, readPhisPaymentOperation, readPhisPaymentProfile,
  readPhisPaymentRefund, writePhisPayment, writePhisPaymentOperation, writePhisPaymentRefund, finishPhisPaymentReceipt,
} from "../../db/payments.mts";
import { withPoolTransaction } from "../db-transaction.ts";
import { PHIS_PAYMENT_CALL_TIMEOUT_MS, PHIS_PAYMENT_ERROR_CODES } from "../constants/payments.ts";
import { PhisPaymentError, copyPhisPaymentAdditions, normalizePhisPaymentTotals, phisPaymentMethodSupports, phisPaymentPricingSelector,
  phisPaymentReturnUrl, requirePhisPaymentMinor, requirePhisPaymentReference, validatePhisPaymentMoney, validatePhisPaymentObservation,
  validatePhisPaymentPricing, validatePhisPaymentPricingSelector, validatePhisPaymentProviderProbe } from "./validation.ts";
import type {
  PhisPaymentProfile, PhisPaymentReceipt, PhisPaymentScope, PhisStoredPayment, PhisStoredPaymentCommand,
  PhisStoredPaymentOperation, PhisStoredPaymentRefund,
} from "./types.ts";

type Action = PhisStoredPaymentOperation["record"]["action"];
type MutationInput = { paymentId: string; idempotencyKey: string; minor?: string; reason?: string };
type Options = {
  pool: Pool;
  scope: PhisPaymentScope;
  signal: AbortSignal;
  publicBaseUrl: () => Promise<string>;
  resolveProvider: (profile: PhisPaymentProfile) => Promise<PhisPaymentProviderV1>;
  merchantAuthorized: (action: "capture" | "cancel" | "refund", policy: PhisPaymentMerchantActionPolicy) => Promise<boolean>;
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
  call: "probe" | "execute" | "recover" | "reconcile";
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

  async listMethods(input: Parameters<PhisPaymentsCapabilityV1["listMethods"]>[0]) {
    input = structuredClone(input);
    validatePhisPaymentMoney(input.amount);
    this.validateFlow(input.captureMode, input.checkoutKind);
    const pricing = validatePhisPaymentPricingSelector(input.pricing);
    const profile = await this.profile(input.profileKey, "read", true);
    return this.methods(profile, { amount: { currency: input.amount.currency, minor: input.amount.minor }, captureMode: input.captureMode, checkoutKind: input.checkoutKind, pricing });
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
    return normalized.methods.filter(m => m.features.captureModes.includes(input.captureMode) && m.features.checkoutKinds.includes(input.checkoutKind)
      && phisPaymentMethodSupports(m.features.pricing, input.pricing)).map(method => ({ ...method, profileKey: profile.key }));
  }

  async create(input: PhisPaymentCreateInput): Promise<PhisPaymentCommandResult> {
    input = structuredClone(input);
    const exponent = validatePhisPaymentMoney(input.amount);
    requirePhisPaymentReference(input.reference); requirePhisPaymentReference(input.idempotencyKey); requirePhisPaymentReference(input.profileKey);
    this.validateFlow(input.captureMode, input.checkoutKind);
    if (typeof input.description !== "string" || input.description.length < 1 || input.description.length > 200
      || (input.methodKey !== null && (typeof input.methodKey !== "string" || input.methodKey.length > 255))) throw new PhisPaymentError("invalid_input");
    const pricing = validatePhisPaymentPricing(input.pricing, input.amount);
    const profile = await this.profile(input.profileKey, "create");
    const request = { profileKey: input.profileKey, reference: input.reference, amount: { currency: input.amount.currency, minor: input.amount.minor }, pricing,
      description: input.description, captureMode: input.captureMode, methodKey: input.methodKey, checkoutKind: input.checkoutKind, returnPath: input.returnPath };
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
    const available = await this.methods(profile, { amount: request.amount, captureMode: input.captureMode, checkoutKind: input.checkoutKind, pricing: phisPaymentPricingSelector(pricing) });
    const method = available.find(m => m.methodKey === input.methodKey);
    if (!method) throw new PhisPaymentError("method_unavailable");
    const providerId = profile.providerAddonId.slice(1).split("/").map(encodeURIComponent).join("/");
    const notificationUrl = new URL(`/api/hooks/${providerId}/payments/${encodeURIComponent(profile.key)}`, baseUrl).href;
    const operationId = randomUUID();
    const payment: PhisStoredPayment = {
      siteId: this.scope.siteId, consumerAddonId: this.scope.consumerAddonId, providerKey: profile.providerKey,
      merchantIdentity: profile.merchantIdentity!, profileRevision: profile.revision, currencyExponent: exponent, features: method.features,
      binding: null, generation: 0, leaseToken: null, leaseUntil: null,
      record: { id, reference: input.reference, profileKey: profile.key, mode: profile.mode, amount: request.amount, pricing, totals: null, captureMode: input.captureMode,
        status: "created", authorizedMinor: "0", capturedMinor: "0", refundedMinor: "0", authorizationExpiresAt: null,
        checkout: null, reconciliationRequired: true, version: 1, lastObservedAt: null },
    };
    const operation: PhisStoredPaymentOperation = {
      record: { id: operationId, paymentId: id, action: "create", state: "reserved", errorCode: null }, request,
      command: { action: "create", operationId, paymentId: id, providerIdempotencyKey: operationId, amount: request.amount, pricing,
        description: input.description, captureMode: input.captureMode, methodKey: input.methodKey, checkoutKind: input.checkoutKind, returnUrl, notificationUrl },
    };
    const reservation = await withPoolTransaction(this.pool, async db => {
      const found = await findPhisPaymentIdempotency(db, this.scope, "create", input.idempotencyKey);
      if (found) { if (!isDeepStrictEqual(found.request, request)) throw new PhisPaymentError("idempotency_conflict"); return found; }
      await this.checkProfileRevision(db, profile, "create");
      await insertPhisPayment(db, payment); await insertPhisPaymentOperation(db, this.scope, input.idempotencyKey, operation);
      await writePhisPayment(db, payment, { operationId, refundId: null });
      await claimPhisPayment(db, payment);
      return null;
    });
    if (reservation) return this.resume(reservation.record.id);
    return this.runCommand(payment, profile, operation, false);
  }

  private async checkProfileRevision(db: PoolClient, expected: PhisPaymentProfile, action: PhisPaymentGrantedOperation) {
    const current = await readPhisPaymentProfile(db, this.scope.siteId, expected.key, true);
    if (!current || current.revision !== expected.revision || !current.grants.find(g => g.consumerAddonId === this.scope.consumerAddonId)?.operations.includes(action)) throw new PhisPaymentError("profile_unavailable");
  }

  complete(input: MutationInput) { return this.mutate("complete", input); }
  cancel(input: MutationInput) { return this.mutate("cancel", input); }
  capture(input: MutationInput & { minor: string }) { return this.mutate("capture", input); }
  refund(input: MutationInput & { minor: string; reason: string }) { return this.mutate("refund", input); }

  private async mutate(action: Exclude<Action, "create">, input: MutationInput): Promise<PhisPaymentCommandResult> {
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
    const found = await this.persisted(operation.record.paymentId, operation.record.action);
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
      const recovery = unresolved.find(o => o.record.action === "create") ?? unresolved[0];
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
        changedRefundId = this.applyObservation(payment, result.observation, operations, refunds);
        if (operation && operation.record.action !== "refund") {
          const confirmed = operation.record.action === "create" || operation.record.action === "complete"
            || (operation.record.action === "capture" && result.observation.status === "captured" && "minor" in operation.command && result.observation.capturedMinor === operation.command.minor)
            || (operation.record.action === "cancel" && ["canceled", "expired"].includes(result.observation.status));
          if (confirmed) {
            operation.record.state = result.outcome === "pending" && ["create", "complete"].includes(operation.record.action) ? "pending" : "succeeded";
            operation.record.errorCode = null;
          }
          else { operation.record.state = "indeterminate"; operation.record.errorCode = "reconciliation_required"; }
        }
      } else if (operation) {
        operation.record.state = result.outcome === "rejected" ? "failed" : "indeterminate";
        operation.record.errorCode = result.outcome === "rejected" ? result.code : "reconciliation_required";
        if (result.outcome === "rejected" && operation.record.action === "create") payment.record.status = "failed";
        if (result.outcome === "rejected" && operation.record.action === "refund") {
          const refund = refunds.find(r => r.operationId === operationId);
          if (refund) { refund.record.status = "failed"; changedRefundId = refund.record.id; }
        }
      }
      for (const op of operations) await writePhisPaymentOperation(db, op);
      for (const refund of refunds) await writePhisPaymentRefund(db, refund);
      payment.record.reconciliationRequired = operations.some(o => ["reserved", "indeterminate"].includes(o.record.state));
      const comparable = { ...payment.record, lastObservedAt: before.lastObservedAt };
      const changed = !isDeepStrictEqual(before, comparable) || !isDeepStrictEqual(beforeOperations, operations.map(o => o.record)) || !isDeepStrictEqual(beforeRefunds, refunds.map(r => r.record));
      if (changed) payment.record.version += 1;
      await writePhisPayment(db, payment, changed ? { operationId, refundId: changedRefundId } : null);
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
      if (operation.record.action === "create" || (operation.record.action === "complete" && ["authorized", "captured", "canceled", "expired", "failed"].includes(observation.status))
        || (operation.record.action === "capture" && observation.status === "captured" && "minor" in operation.command && operation.command.minor === observation.capturedMinor)
        || (operation.record.action === "cancel" && ["expired", "canceled"].includes(observation.status))) {
        operation.record.state = "succeeded"; operation.record.errorCode = null;
      }
    }
    return changedRefundId;
  }
}
