import type { Pool } from "pg";

import { listPhisPaymentRecoveryCandidates, readPhisPayment, readPhisPaymentProfile } from "../../db/payments.mts";
import { PHIS_PAYMENT_CALL_TIMEOUT_MS, PHIS_PAYMENT_RECOVERY_LIMIT } from "../constants/payments.ts";
import { PhisPaymentEngine } from "./engine.ts";
import { PhisPaymentError } from "./validation.ts";
import type { PhisPaymentProfile } from "./types.ts";

type EngineOptions = ConstructorParameters<typeof PhisPaymentEngine>[0];

/**
 * Asks the Provider for the state of every payment that has an unresolved operation, and writes down
 * what it says. The one implementation behind the Core job `payments.recover` and `phis maintain --task
 * payments`; each hands in how its own process reaches a Provider.
 *
 * Nothing is replayed. A reconciliation observes -- or asks the Provider how a command it already sent
 * turned out -- and never sends a command again, so running it twice, or from two processes at the same
 * moment, cannot move money twice. A payment another reconciliation holds is skipped: the claim on the
 * payment is a lease, and a reconciliation that cannot take it answers `provider_unavailable` for that
 * one payment, which is counted below and does not fail the run. What it left is offered again next time.
 *
 * Bounded at `PHIS_PAYMENT_RECOVERY_LIMIT` payments a run, oldest update first. The loop stops between
 * two payments when `signal` aborts.
 */
export async function reconcilePhisPayments(input: {
  pool: Pool;
  dryRun: boolean;
  signal?: AbortSignal;
  resolveProvider: (profile: PhisPaymentProfile, siteKey: string) => ReturnType<EngineOptions["resolveProvider"]>;
  engine?: Pick<EngineOptions, "providerFailed" | "reconcileRepeated" | "entitlementListeners">;
}) {
  const { pool, dryRun, signal, resolveProvider } = input;
  const candidates = await listPhisPaymentRecoveryCandidates(pool, PHIS_PAYMENT_RECOVERY_LIMIT);
  const siteIds = new Set<number>();
  if (dryRun) {
    return { cleared: 0, siteIds, detail: `${candidates.length} payment(s) selected for bounded reconciliation; no Provider calls made.` };
  }
  let reconciled = 0;
  let unavailable = 0;
  for (const candidate of candidates) {
    if (signal?.aborted) break;
    try {
      const payment = (await readPhisPayment(pool, candidate.site_id, candidate.id))!;
      const profile = (await readPhisPaymentProfile(pool, candidate.site_id, payment.record.profileKey))!;
      if (!profile) throw new PhisPaymentError("profile_unavailable");
      const engine = new PhisPaymentEngine({
        ...input.engine,
        pool,
        scope: { siteId: candidate.site_id, siteKey: candidate.key, consumerAddonId: candidate.consumer_addon_id },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(PHIS_PAYMENT_CALL_TIMEOUT_MS)])
          : AbortSignal.timeout(PHIS_PAYMENT_CALL_TIMEOUT_MS),
        publicBaseUrl: async () => { throw new PhisPaymentError("forbidden"); },
        resolveProvider: (resolved) => resolveProvider(resolved, candidate.key),
        merchantAuthorized: async () => false,
      });
      await engine.reconcile(payment, profile);
      reconciled += 1;
      siteIds.add(candidate.site_id);
    } catch { unavailable += 1; }
  }
  return {
    cleared: reconciled,
    siteIds,
    detail: `${reconciled} reconciled; ${unavailable} unavailable or concurrently claimed (limit ${PHIS_PAYMENT_RECOVERY_LIMIT}).`,
  };
}
