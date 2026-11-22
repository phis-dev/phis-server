import "server-only";
import { listPhisEntitlementListeners } from "@/lib/addons/entitlements-capability";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import type { PhisPaymentNotificationsCapabilityV1 } from "@phis/contracts/payments";
import { getPool } from "../db";
import { getSiteByKey } from "../../db/sites";
import {
  claimPhisPaymentReceipt, findPhisPaymentForNotification, findPhisPaymentStoredMethodsForNotification, readPhisPaymentProfile,
  releasePhisPaymentReceipt,
} from "../../db/payments.mts";
import { claimDuePhisPaymentSubscriptions, releasePhisPaymentSubscription } from "../../db/payment-subscriptions.mts";
import { withPoolTransaction } from "../db-transaction.ts";
import { resolvePhisServiceProvider } from "../addons/services.ts";
import { holdsPhisSiteAccess } from "../addons/site-access.ts";
import { buildPhisAddonRolesCapability } from "../addons/roles-capability.ts";
import { schedulePhisAddonEventDelivery } from "../addons/event-trigger.ts";
import { resolvePhiSecret } from "../secrets/resolver";
import { logRuntimeEvent, normalizeLogThrowable } from "../log";
import { PHIS_SERVICE_KINDS, PHIS_SITE_ACCESS } from "@phis/contracts/addon";
import { PhisPaymentEngine, type PhisPaymentProviderFailure } from "./engine.ts";
import { createPhisPaymentProvider } from "./provider.ts";
import { reconcilePhisPayments } from "./recovery.ts";
import { PhisPaymentError, requirePhisPaymentReference } from "./validation.ts";
import type { PhisPaymentAuthority, PhisPaymentProfile, PhisPaymentScope } from "./types.ts";

async function provider(profile: PhisPaymentProfile, siteKey: string) {
  const resolved = await resolvePhisServiceProvider(PHIS_SERVICE_KINDS.payments, profile.providerKey, { siteId: profile.siteId });
  if (resolved.addonId !== profile.providerAddonId) throw new PhisPaymentError("profile_unavailable");
  return createPhisPaymentProvider(resolved.factory, profile, siteKey,
    reference => resolvePhiSecret({ kind: "addon", addonId: profile.providerAddonId }, reference));
}

function afterPaymentCommit<Args extends unknown[], Result>(siteId: number, action: (...args: Args) => Promise<Result>) {
  return async (...args: Args): Promise<Result> => {
    const result = await action(...args);
    schedulePhisAddonEventDelivery(siteId);
    return result;
  };
}


/** A reconciliation that observed again because a notification arrived while it held the payment. */
function logPhisPaymentReconcileRepeated(repeat: { siteId: number; consumerAddonId: string; paymentId: string; repeat: number; limit: number }) {
  logRuntimeEvent("info", "payment.reconcile.repeated", {
    message: "A payment was reconciled again because a notification arrived while it was being reconciled.",
    pluginKey: repeat.consumerAddonId,
    meta: { paymentId: repeat.paymentId, repeat: repeat.repeat, limit: repeat.limit },
  });
}

/**
 * A Provider that failed, in the log: a Provider bug, a secret that ran out and a network that was down
 * all read as "reconciliation required" with no line to find them by until this was written.
 */
function logPhisPaymentProviderFailure(failure: PhisPaymentProviderFailure) {
  logRuntimeEvent("error", "payment.provider.failed", {
    message: `The payment Provider failed on ${failure.call}.`,
    pluginKey: failure.meta.consumerAddonId,
    error: normalizeLogThrowable(failure.error),
    meta: { ...failure.meta, call: failure.call },
  });
}

export function buildPhisPaymentsCapability(input: {
  scope: PhisPaymentScope; manifest: PhisAddonManifestV1; authority: PhisPaymentAuthority; signal: AbortSignal;
}) {
  const { scope, manifest, authority } = input;
  const roles = buildPhisAddonRolesCapability({ addonId: scope.consumerAddonId, siteId: scope.siteId,
    actorUserId: authority.kind === "request" ? authority.actorUserId : null, declared: manifest.roles ?? [] });
  const engine = new PhisPaymentEngine({ providerFailed: logPhisPaymentProviderFailure, reconcileRepeated: logPhisPaymentReconcileRepeated, entitlementListeners: listPhisEntitlementListeners,
    pool: getPool(), scope, signal: input.signal,
    publicBaseUrl: async () => { const site = await getSiteByKey(scope.siteKey); if (!site) throw new PhisPaymentError("not_found"); return site.publicBaseUrl; },
    resolveProvider: profile => provider(profile, scope.siteKey),
    unauthenticated: authority.kind === "hook",
    merchantAuthorized: async (_action, policy) => {
      if (authority.kind === "hook") return false;
      if (authority.kind === "job") return manifest.jobs.some(j => j.id === authority.id) && policy.jobs.includes(authority.id);
      if (authority.kind === "event") return !!manifest.eventHandlers?.some(e => e.event === authority.id) && policy.events.includes(authority.id);
      if (authority.operator) return true;
      if (authority.actorUserId === null) return false;
      if (await holdsPhisSiteAccess(scope.siteId, authority.actorUserId, PHIS_SITE_ACCESS.siteAdmin)) return true;
      for (const role of policy.roles) if (await roles.has(role)) return true;
      return false;
    },
  });
  return Object.freeze({
    listMethods: engine.listMethods.bind(engine),
    // Reads and writes the profile's recording only: no payment changes, so there is no event to deliver.
    profileReach: engine.profileReach.bind(engine), refreshProfileReach: engine.refreshProfileReach.bind(engine),
    create: afterPaymentCommit(scope.siteId, engine.create.bind(engine)), get: engine.get.bind(engine),
    getOperation: engine.getOperation.bind(engine), getRefund: engine.getRefund.bind(engine), complete: afterPaymentCommit(scope.siteId, engine.complete.bind(engine)),
    refresh: afterPaymentCommit(scope.siteId, engine.refresh.bind(engine)), capture: afterPaymentCommit(scope.siteId, engine.capture.bind(engine)),
    cancel: afterPaymentCommit(scope.siteId, engine.cancel.bind(engine)), refund: afterPaymentCommit(scope.siteId, engine.refund.bind(engine)),
    getStoredMethod: engine.getStoredMethod.bind(engine), listStoredMethods: engine.listStoredMethods.bind(engine),
    removeStoredMethod: afterPaymentCommit(scope.siteId, engine.removeStoredMethod.bind(engine)),
    createSubscription: afterPaymentCommit(scope.siteId, engine.createSubscription.bind(engine)),
    getSubscription: engine.getSubscription.bind(engine), listSubscriptionPeriods: engine.listSubscriptionPeriods.bind(engine),
    cancelSubscription: afterPaymentCommit(scope.siteId, engine.cancelSubscription.bind(engine)),
    resumeSubscription: afterPaymentCommit(scope.siteId, engine.resumeSubscription.bind(engine)),
    settleSubscription: afterPaymentCommit(scope.siteId, engine.settleSubscription.bind(engine)),
    replaceSubscriptionMethod: afterPaymentCommit(scope.siteId, engine.replaceSubscriptionMethod.bind(engine)),
    setupMethod: afterPaymentCommit(scope.siteId, engine.setupMethod.bind(engine)),
    refreshStoredMethod: afterPaymentCommit(scope.siteId, engine.refreshStoredMethod.bind(engine)),
    changeSubscriptionPrice: afterPaymentCommit(scope.siteId, engine.changeSubscriptionPrice.bind(engine)),
  });
}

/**
 * The schedule: every subscription that owes something now, one after another, each under a lease.
 *
 * It acts as nobody. The engine it builds holds the consumer's scope, because a scheduled charge is made
 * under the consumer's stored agreement and its grant, and it authorizes no merchant action at all. One
 * subscription that fails does not stop the others; what it could not do it will be offered again.
 */
export async function runDuePhisPaymentSubscriptions(limit = 50, signal: AbortSignal = new AbortController().signal) {
  const pool = getPool();
  const due = await withPoolTransaction(pool, db => claimDuePhisPaymentSubscriptions(db, limit));
  const sites = new Set<number>();
  for (const subscription of due) {
    if (signal.aborted) break;
    const scope = { siteId: subscription.siteId, siteKey: subscription.siteKey, consumerAddonId: subscription.consumerAddonId };
    try {
      const engine = new PhisPaymentEngine({ providerFailed: logPhisPaymentProviderFailure, reconcileRepeated: logPhisPaymentReconcileRepeated, entitlementListeners: listPhisEntitlementListeners, pool, scope, signal,
        publicBaseUrl: async () => { const site = await getSiteByKey(scope.siteKey); if (!site) throw new PhisPaymentError("not_found"); return site.publicBaseUrl; },
        resolveProvider: profile => provider(profile, scope.siteKey), merchantAuthorized: async () => false });
      const outcome = await engine.advanceSubscription(subscription.record.id);
      if (outcome) {
        logRuntimeEvent("warn", "payment.subscription.postponed", {
          message: "A subscription period could not be charged and is looked at again in an hour.",
          siteKey: scope.siteKey,
          pluginKey: scope.consumerAddonId,
          error: normalizeLogThrowable(outcome.postponed),
          meta: { subscriptionId: subscription.record.id, code: outcome.postponed instanceof PhisPaymentError ? outcome.postponed.code : null },
        });
      }
    } catch (error) {
      logRuntimeEvent("error", "payment.subscription.schedule_failed", {
        message: "The schedule could not advance a subscription.",
        siteKey: scope.siteKey,
        pluginKey: scope.consumerAddonId,
        error: normalizeLogThrowable(error),
        meta: { subscriptionId: subscription.record.id },
      });
    } finally {
      sites.add(scope.siteId);
      if (subscription.leaseToken) await releasePhisPaymentSubscription(pool, subscription.record.id, subscription.leaseToken).catch(() => {});
    }
  }
  for (const siteId of sites) schedulePhisAddonEventDelivery(siteId);
  return due.length;
}

/**
 * The schedule's reconciliation: every payment with an unresolved operation, asked of its Provider.
 *
 * It reaches the Provider the way the subscription schedule does -- through the installed Add-on, with
 * the secrets this process already holds -- and shares everything else with `phis maintain --task
 * payments` (`reconcilePhisPayments`). It acts as nobody, replays no command, and skips a payment
 * another reconciliation holds, so a run that overlaps another, on this instance or on one of its
 * siblings, changes nothing the other did not.
 */
export async function reconcileUnresolvedPhisPayments(signal: AbortSignal = new AbortController().signal) {
  const result = await reconcilePhisPayments({
    pool: getPool(), dryRun: false, signal,
    resolveProvider: (profile, siteKey) => provider(profile, siteKey),
    engine: { providerFailed: logPhisPaymentProviderFailure, reconcileRepeated: logPhisPaymentReconcileRepeated, entitlementListeners: listPhisEntitlementListeners },
  });
  for (const siteId of result.siteIds) schedulePhisAddonEventDelivery(siteId);
  return { cleared: result.cleared, detail: result.detail };
}

/** Available only for a dispatcher-bound hook. Successful verification grants no ambient authority. */
export function buildPhisPaymentNotificationsCapability(input: {
  scope: PhisPaymentScope; method: string; headers: Readonly<Record<string, string>>; body: Uint8Array; signal: AbortSignal;
}): PhisPaymentNotificationsCapabilityV1 {
  const body = new Uint8Array(input.body); const headers = Object.freeze({ ...input.headers });
  return Object.freeze({
    async receive({ profileKey }: { profileKey: string }) {
      requirePhisPaymentReference(profileKey);
      const profile = await readPhisPaymentProfile(getPool(), input.scope.siteId, profileKey);
      if (!profile || profile.providerAddonId !== input.scope.consumerAddonId || !profile.merchantIdentity) throw new PhisPaymentError("invalid_input");
      /*
       * A notification Core does not take is answered as a refusal the Provider acts on -- it sends the
       * delivery again, or gives up -- and until now left no line here: a 503 in the Site's log and nothing
       * in Core's said which of four reasons it was. Each is named, with what the delivery was about.
       */
      const refused = (code: "invalid_input" | "provider_unavailable", reason: string, meta: Record<string, unknown> = {}) => {
        logRuntimeEvent("warn", "payment.notification.refused", {
          message: `A payment notification was refused: ${reason}.`,
          siteKey: input.scope.siteKey,
          meta: { reason, code, profileKey: profile.key, ...meta },
        });
        return new PhisPaymentError(code);
      };
      let verified;
      let adapter;
      try {
        adapter = await provider(profile, input.scope.siteKey);
        verified = await adapter.verifyNotification({ method: input.method, headers, body: new Uint8Array(body), signal: input.signal });
      } catch (error) {
        logRuntimeEvent("error", "payment.provider.failed", {
          message: "The payment Provider failed on verifyNotification.",
          siteKey: input.scope.siteKey,
          error: normalizeLogThrowable(error),
          meta: { call: "verifyNotification", profileKey: profile.key },
        });
        throw new PhisPaymentError("provider_unavailable");
      }
      if (verified.outcome === "rejected") throw refused("invalid_input", "the Provider rejected its signature or shape");
      if (verified.outcome === "unavailable") throw refused("provider_unavailable", "the Provider could not verify it now");
      if (verified.outcome === "irrelevant") return { outcome: "ignored" as const };
      requirePhisPaymentReference(verified.reference);
      if (verified.subject === "stored-method") {
        /*
         * A stored method changed outside phis: revoked by the payer, expired, replaced. There is no
         * receipt to claim, because the answer is read from the Provider again and writing the same
         * state twice changes nothing.
         */
        const methods = await findPhisPaymentStoredMethodsForNotification(getPool(), profile.siteId, profileKey, verified.reference);
        if (methods.length === 0) return { outcome: "ignored" as const };
        for (const method of methods) {
          const engine = new PhisPaymentEngine({ providerFailed: logPhisPaymentProviderFailure, reconcileRepeated: logPhisPaymentReconcileRepeated, entitlementListeners: listPhisEntitlementListeners, pool: getPool(), scope: { ...input.scope, consumerAddonId: method.consumerAddonId }, signal: input.signal,
            publicBaseUrl: async () => { throw new PhisPaymentError("forbidden"); }, resolveProvider: async () => adapter!, merchantAuthorized: async () => false });
          await engine.reconcileStoredMethod(method, profile);
        }
        return { outcome: "processed" as const };
      }
      const payment = await findPhisPaymentForNotification(getPool(), profile.siteId, profileKey, verified.reference);
      if (!payment) throw refused("provider_unavailable", "no payment of this profile has the reference it names", { reference: verified.reference, subject: verified.subject });
      let receipt;
      if (verified.outcome === "verified") {
        requirePhisPaymentReference(verified.deliveryId);
        const claim = await claimPhisPaymentReceipt(getPool(), payment, verified.deliveryId);
        if (claim === "duplicate") {
          schedulePhisAddonEventDelivery(profile.siteId);
          return { outcome: "duplicate" as const };
        }
        if (claim === "busy") throw refused("provider_unavailable", "the same delivery is being processed by another call", { reference: verified.reference, deliveryId: verified.deliveryId });
        receipt = claim;
      }
      const engine = new PhisPaymentEngine({ providerFailed: logPhisPaymentProviderFailure, reconcileRepeated: logPhisPaymentReconcileRepeated, entitlementListeners: listPhisEntitlementListeners, pool: getPool(), scope: { ...input.scope, consumerAddonId: payment.consumerAddonId }, signal: input.signal,
        publicBaseUrl: async () => { throw new PhisPaymentError("forbidden"); }, resolveProvider: async () => adapter!, merchantAuthorized: async () => false });
      let reconciled;
      try { reconciled = await engine.reconcileNotified(payment, profile, receipt); }
      catch (error) {
        if (receipt) await releasePhisPaymentReceipt(getPool(), profile.siteId, receipt).catch(() => {});
        // The Provider did not answer, or the reconciliation refused what it said. A payment held by another
        // reconciliation is not among the causes: the knock is remembered and answered as taken.
        if (error instanceof PhisPaymentError) {
          logRuntimeEvent("warn", "payment.notification.refused", {
            message: "A payment notification was refused: the payment could not be reconciled.",
            siteKey: input.scope.siteKey,
            meta: {
              reason: error.code === "provider_unavailable"
                ? "the Provider did not answer, or the reconciliation could not be applied"
                : "the reconciliation refused it",
              code: error.code,
              profileKey: profile.key,
              reference: verified.reference,
              paymentId: payment.record.id,
              ...(verified.outcome === "verified" ? { deliveryId: verified.deliveryId } : {}),
            },
          });
        }
        throw error;
      }
      if (reconciled === "remembered") {
        logRuntimeEvent("info", "payment.notification.remembered", {
          message: "A payment notification met a payment another call holds and was remembered on it.",
          siteKey: input.scope.siteKey,
          meta: { profileKey: profile.key, paymentId: payment.record.id, reference: verified.reference,
            ...(verified.outcome === "verified" ? { deliveryId: verified.deliveryId } : {}) },
        });
      }
      schedulePhisAddonEventDelivery(profile.siteId);
      return { outcome: "processed" as const };
    },
  });
}
