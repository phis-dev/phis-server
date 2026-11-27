import type { Pool } from "pg";
import type { PhisPaymentProviderSettlement, PhisPaymentProviderV1, PhisPaymentSettlement } from "@phis/contracts/payments";
import {
  claimDuePhisPaymentRecordTasks, finishPhisPaymentRecordTask, insertPhisPaymentSettlements, listSettledPhisPaymentParts, type PhisPaymentRecordTask,
} from "../../db/payment-records.mts";
import { listPhisPaymentRefunds, readPhisPayment, readPhisPaymentProfile } from "../../db/payments.mts";
import { withPoolTransaction } from "../db-transaction.ts";
import { PHIS_PAYMENT_CALL_TIMEOUT_MS, PHIS_PAYMENT_LEASE_SECONDS } from "../constants/payments.ts";
import { PhisPaymentError, requirePhisPaymentMinor, requirePhisPaymentReference, validatePhisPaymentMoney } from "./validation.ts";
import type { PhisPaymentProfile, PhisStoredPayment } from "./types.ts";

/**
 * The Core job `payments.records.collect` (PAYMENTS.md, records): what a Provider documents and settles for
 * a capture or a succeeded refund, asked after the fact and again until it is all there.
 *
 * Bounded per run, safe to run twice and from two Instances at once: every task is taken under a lease, a
 * settlement is recorded once by its reference, and a document once by its reference. A Provider that
 * cannot be reached uses no attempt; one that answers "not yet" uses one. After 14 days a task is given up.
 */

const MINUTE = 60_000;
/** After the first, second, third and fourth attempt; daily from then on. */
const RETRY_DELAYS_MS = [5 * MINUTE, 15 * MINUTE, 60 * MINUTE, 6 * 60 * MINUTE];
const DAY_MS = 24 * 60 * MINUTE;
export const PHIS_PAYMENT_RECORDS_GIVE_UP_DAYS = 14;
export const PHIS_PAYMENT_RECORDS_BATCH = 50;

/** When an attempt after `attempts` counted ones is made. */
export function nextPhisPaymentRecordAttempt(attempts: number, now = new Date()): Date {
  return new Date(now.getTime() + (RETRY_DELAYS_MS[attempts] ?? DAY_MS));
}

/** Not yet all there: ask again, or give up where the task is older than the 14 days. */
export function phisPaymentRecordRetry(task: Pick<PhisPaymentRecordTask, "attempts" | "createdAt">, counted: boolean, error: string | null, now = new Date()) {
  const next = nextPhisPaymentRecordAttempt(task.attempts + (counted ? 1 : 0), now);
  if (next.getTime() > Date.parse(task.createdAt) + PHIS_PAYMENT_RECORDS_GIVE_UP_DAYS * DAY_MS) {
    return { state: "failed" as const, error: error ?? "The Provider did not complete the records within 14 days." };
  }
  return { state: "retry" as const, next, counted, error };
}

const ISO = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));

/**
 * The settlements a Provider reported for a payment, checked and given Core's ids: the money in the right
 * currencies, `net` the sum of the rest, a refund's record named by a refund Core knows. A record of a
 * refund Core has not observed yet is left for the next attempt.
 */
export function readPhisPaymentProviderSettlements(payment: PhisStoredPayment, refunds: readonly { id: string; reference: string | null }[],
  records: readonly PhisPaymentProviderSettlement[]): { records: Omit<PhisPaymentSettlement, "id" | "paymentId" | "recordedAt">[]; unknownRefund: boolean } {
  const fail = (): never => { throw new PhisPaymentError("provider_unavailable", "Provider returned inconsistent settlement facts."); };
  if (!Array.isArray(records) || records.length > 200) fail();
  const seen = new Set<string>();
  let unknownRefund = false;
  const result: Omit<PhisPaymentSettlement, "id" | "paymentId" | "recordedAt">[] = [];
  for (const record of records) {
    try {
      requirePhisPaymentReference(record.reference);
      if (seen.has(record.reference) || (record.direction !== "credit" && record.direction !== "debit")) fail();
      seen.add(record.reference);
      for (const money of [record.gross, record.settled, record.fee, record.net, ...(record.withheldTax ? [record.withheldTax] : [])]) {
        validatePhisPaymentMoney(money, false); requirePhisPaymentMinor(money.minor);
      }
      if (record.gross.currency !== payment.record.amount.currency) fail();
      const currency = record.settled.currency;
      if (record.fee.currency !== currency || record.net.currency !== currency || (record.withheldTax && record.withheldTax.currency !== currency)) fail();
      if (BigInt(record.settled.minor) - BigInt(record.fee.minor) - BigInt(record.withheldTax?.minor ?? "0") !== BigInt(record.net.minor)) fail();
      if (record.exchangeRate !== null && (typeof record.exchangeRate !== "string" || !/^[0-9]{1,10}(\.[0-9]{1,10})?$/.test(record.exchangeRate)
        || Number(record.exchangeRate) <= 0)) fail();
      if ((record.availableAt !== null && !ISO(record.availableAt)) || !ISO(record.bookedAt)) fail();
    } catch (error) { if (error instanceof PhisPaymentError && error.code === "provider_unavailable") throw error; fail(); }
    let refundId: string | null = null;
    if (record.refund !== null) {
      const refund = refunds.find(entry => entry.reference !== null && entry.reference === record.refund!.reference);
      if (!refund) { unknownRefund = true; continue; }
      refundId = refund.id;
    }
    result.push({ refundId, direction: record.direction, reference: record.reference, gross: { ...record.gross }, settled: { ...record.settled }, fee: { ...record.fee },
      withheldTax: record.withheldTax ? { ...record.withheldTax } : null, net: { ...record.net }, exchangeRate: record.exchangeRate,
      availableAt: record.availableAt === null ? null : new Date(record.availableAt).toISOString(), bookedAt: new Date(record.bookedAt).toISOString() });
  }
  return { records: result, unknownRefund };
}

/** One settlements task: `done` once the capture or refund it stands for is recorded and the Provider says it is complete. */
async function collectSettlements(pool: Pool, task: PhisPaymentRecordTask, payment: PhisStoredPayment, profile: PhisPaymentProfile,
  provider: PhisPaymentProviderV1, signal: AbortSignal): Promise<"done" | "partial"> {
  if (!provider.observeSettlements) throw new PhisPaymentError("unsupported_operation", "The Provider declares settlement records and does not report them.");
  // db-boundary-exempt: the Provider executes a PSP HTTP call and receives no database handle.
  const answer = await provider.observeSettlements({ binding: payment.binding!, signal: AbortSignal.any([signal, AbortSignal.timeout(PHIS_PAYMENT_CALL_TIMEOUT_MS)]) });
  if (!answer || (answer.state !== "complete" && answer.state !== "partial")) throw new PhisPaymentError("provider_unavailable");
  const refunds = (await listPhisPaymentRefunds(pool, payment.record.id)).map(refund => ({ id: refund.record.id, reference: refund.binding?.reference ?? null }));
  const read = readPhisPaymentProviderSettlements(payment, refunds, answer.records);
  await withPoolTransaction(pool, db => insertPhisPaymentSettlements(db, { siteId: payment.siteId, profileKey: profile.key, paymentId: payment.record.id, records: read.records }));
  const settled = await listSettledPhisPaymentParts(pool, payment.record.id);
  return answer.state === "complete" && !read.unknownRefund && settled.includes(task.refundId) ? "done" : "partial";
}

export type PhisPaymentRecordCollector = (input: {
  task: PhisPaymentRecordTask; payment: PhisStoredPayment; profile: PhisPaymentProfile; provider: PhisPaymentProviderV1; signal: AbortSignal;
}) => Promise<"done" | "partial">;

/**
 * One run of the job: the tasks that are due, each done, asked again later, or given up. `resolveProvider`
 * reaches the Provider as the schedule does; `collectDocuments` is the archive's (`billing:v1`). Answers
 * the Sites whose documents changed, for the event delivery, and what was done.
 */
export async function collectPhisPaymentRecords(input: {
  pool: Pool;
  signal: AbortSignal;
  resolveProvider: (profile: PhisPaymentProfile, siteKey: string) => Promise<PhisPaymentProviderV1>;
  /** Absent: documents tasks wait for a run that has the archive. */
  collectDocuments?: PhisPaymentRecordCollector;
  failed?: (task: PhisPaymentRecordTask, error: unknown) => void;
  /** A task given up after its 14 days: what it was collecting is marked as given up (documents `failed`). */
  gaveUp?: (task: PhisPaymentRecordTask) => Promise<void>;
  limit?: number;
}): Promise<{ claimed: number; done: number; failed: number; siteIds: number[] }> {
  const kinds = input.collectDocuments ? ["documents", "settlements"] as const : ["settlements"] as const;
  const tasks = await withPoolTransaction(input.pool, db => claimDuePhisPaymentRecordTasks(db, input.limit ?? PHIS_PAYMENT_RECORDS_BATCH, PHIS_PAYMENT_LEASE_SECONDS * 5, kinds));
  let done = 0; let failed = 0;
  const siteIds = new Set<number>();
  for (const task of tasks) {
    if (input.signal.aborted) {
      await finishPhisPaymentRecordTask(input.pool, task, { state: "retry", next: new Date(), counted: false, error: null });
      continue;
    }
    let outcome: Parameters<typeof finishPhisPaymentRecordTask>[2];
    try {
      const payment = await readPhisPayment(input.pool, task.siteId, task.paymentId);
      const profile = payment ? await readPhisPaymentProfile(input.pool, task.siteId, payment.record.profileKey) : null;
      if (!payment || !profile || !payment.binding) throw new PhisPaymentError("not_found", "The payment of this task cannot be asked about any more.");
      let provider: PhisPaymentProviderV1;
      try { provider = await input.resolveProvider(profile, task.siteKey); }
      catch (error) {
        // Not the customer's or the Provider's answer: no attempt is used.
        outcome = phisPaymentRecordRetry(task, false, error instanceof Error ? error.message : String(error));
        await finishPhisPaymentRecordTask(input.pool, task, outcome);
        if (outcome.state === "failed") { failed += 1; await input.gaveUp?.(task).catch(error => input.failed?.(task, error)); }
        continue;
      }
      const result = task.kind === "settlements"
        ? await collectSettlements(input.pool, task, payment, profile, provider, input.signal)
        : await input.collectDocuments!({ task, payment, profile, provider, signal: input.signal });
      if (task.kind === "documents") siteIds.add(task.siteId);
      outcome = result === "done" ? { state: "done" } : phisPaymentRecordRetry(task, true, null);
    } catch (error) {
      input.failed?.(task, error);
      // A Provider that threw was not reached; one that answered something Core refuses did answer, and that counts.
      const unreachable = !(error instanceof PhisPaymentError);
      outcome = error instanceof PhisPaymentError && (error.code === "not_found" || error.code === "unsupported_operation")
        ? { state: "failed", error: error.message }
        : phisPaymentRecordRetry(task, !unreachable, error instanceof Error ? error.message : String(error));
    }
    await finishPhisPaymentRecordTask(input.pool, task, outcome);
    if (outcome.state === "done") done += 1;
    if (outcome.state === "failed") { failed += 1; await input.gaveUp?.(task).catch(error => input.failed?.(task, error)); }
  }
  return { claimed: tasks.length, done, failed, siteIds: [...siteIds] };
}
