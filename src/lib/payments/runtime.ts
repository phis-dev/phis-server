import "server-only";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import type { PhisPaymentNotificationsCapabilityV1 } from "@phis/contracts/payments";
import { getPool } from "../db";
import { getSiteByKey } from "../../db/sites";
import { claimPhisPaymentReceipt, findPhisPaymentForNotification, readPhisPaymentProfile, releasePhisPaymentReceipt } from "../../db/payments.mts";
import { resolvePhisServiceProvider } from "../addons/services.ts";
import { holdsPhisSiteAccess } from "../addons/site-access.ts";
import { buildPhisAddonRolesCapability } from "../addons/roles-capability.ts";
import { schedulePhisAddonEventDelivery } from "../addons/event-trigger.ts";
import { resolvePhiSecret } from "../secrets/resolver";
import { PHIS_SERVICE_KINDS, PHIS_SITE_ACCESS } from "@phis/contracts/addon";
import { PhisPaymentEngine } from "./engine.ts";
import { createPhisPaymentProvider } from "./provider.ts";
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

export function buildPhisPaymentsCapability(input: {
  scope: PhisPaymentScope; manifest: PhisAddonManifestV1; authority: PhisPaymentAuthority; signal: AbortSignal;
}) {
  const { scope, manifest, authority } = input;
  const roles = buildPhisAddonRolesCapability({ addonId: scope.consumerAddonId, siteId: scope.siteId,
    actorUserId: authority.kind === "request" ? authority.actorUserId : null, declared: manifest.roles ?? [] });
  const engine = new PhisPaymentEngine({
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
    listMethods: engine.listMethods.bind(engine), create: afterPaymentCommit(scope.siteId, engine.create.bind(engine)), get: engine.get.bind(engine),
    getOperation: engine.getOperation.bind(engine), getRefund: engine.getRefund.bind(engine), complete: afterPaymentCommit(scope.siteId, engine.complete.bind(engine)),
    refresh: afterPaymentCommit(scope.siteId, engine.refresh.bind(engine)), capture: afterPaymentCommit(scope.siteId, engine.capture.bind(engine)),
    cancel: afterPaymentCommit(scope.siteId, engine.cancel.bind(engine)), refund: afterPaymentCommit(scope.siteId, engine.refund.bind(engine)),
  });
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
      let verified;
      let adapter;
      try {
        adapter = await provider(profile, input.scope.siteKey);
        verified = await adapter.verifyNotification({ method: input.method, headers, body: new Uint8Array(body), signal: input.signal });
      } catch { throw new PhisPaymentError("provider_unavailable"); }
      if (verified.outcome === "rejected") throw new PhisPaymentError("invalid_input");
      if (verified.outcome === "unavailable") throw new PhisPaymentError("provider_unavailable");
      if (verified.outcome === "irrelevant") return { outcome: "ignored" as const };
      requirePhisPaymentReference(verified.reference);
      const payment = await findPhisPaymentForNotification(getPool(), profile.siteId, profileKey, verified.reference);
      if (!payment) throw new PhisPaymentError("provider_unavailable");
      let receipt;
      if (verified.outcome === "verified") {
        requirePhisPaymentReference(verified.deliveryId);
        const claim = await claimPhisPaymentReceipt(getPool(), payment, verified.deliveryId);
        if (claim === "duplicate") {
          schedulePhisAddonEventDelivery(profile.siteId);
          return { outcome: "duplicate" as const };
        }
        if (claim === "busy") throw new PhisPaymentError("provider_unavailable");
        receipt = claim;
      }
      const engine = new PhisPaymentEngine({ pool: getPool(), scope: { ...input.scope, consumerAddonId: payment.consumerAddonId }, signal: input.signal,
        publicBaseUrl: async () => { throw new PhisPaymentError("forbidden"); }, resolveProvider: async () => adapter!, merchantAuthorized: async () => false });
      try { await engine.reconcile(payment, profile, receipt); }
      catch (error) { if (receipt) await releasePhisPaymentReceipt(getPool(), profile.siteId, receipt).catch(() => {}); throw error; }
      schedulePhisAddonEventDelivery(profile.siteId);
      return { outcome: "processed" as const };
    },
  });
}
