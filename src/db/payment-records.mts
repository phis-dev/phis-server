import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { PhisPaymentSettlement } from "@phis/contracts/payments";
import type { PhisStoredPayment } from "../lib/payments/types.ts";

type Db = Pick<PoolClient, "query">;

/**
 * What Core collects from a Provider after a capture or a succeeded refund (PAYMENTS.md, records): the
 * Provider's documents into `billing:v1` and what the payment settled. One task per payment, refund and
 * kind, written in the transaction that recorded the fact, done by the Core job `payments.records.collect`.
 */
export type PhisPaymentRecordKind = "documents" | "settlements";

export type PhisPaymentRecordTask = {
  id: string;
  siteId: number;
  siteKey: string;
  consumerAddonId: string;
  paymentId: string;
  refundId: string | null;
  kind: PhisPaymentRecordKind;
  attempts: number;
  createdAt: string;
  leaseToken: string;
};

/** Writes the tasks a fact owes, once each: the same capture observed twice owes nothing more. */
export async function enqueuePhisPaymentRecordTasks(db: Db, payment: Pick<PhisStoredPayment, "siteId" | "record">,
  refundIds: readonly (string | null)[], kinds: { documents: boolean; settlements: boolean }) {
  const wanted = (["documents", "settlements"] as const).filter(kind => kinds[kind]);
  if (wanted.length === 0 || refundIds.length === 0) return;
  await db.query(`INSERT INTO phis.payment_record_tasks (site_id, payment_id, refund_id, kind)
    SELECT $1::smallint, $2::uuid, refund.id, kind.kind
    FROM unnest($3::uuid[]) AS refund(id) CROSS JOIN unnest($4::text[]) AS kind(kind)
    ON CONFLICT (payment_id, refund_id, kind) DO NOTHING`,
  [payment.siteId, payment.record.id, refundIds, wanted]);
}

/**
 * The tasks whose next attempt has come, each taken under a lease so that a second run leaves them alone;
 * `SKIP LOCKED` keeps two Instances from waiting on each other.
 */
export async function claimDuePhisPaymentRecordTasks(db: Db, limit: number, leaseSeconds: number,
  kinds: readonly PhisPaymentRecordKind[] = ["documents", "settlements"]): Promise<PhisPaymentRecordTask[]> {
  const token = randomUUID();
  const { rows } = await db.query<{ id: string; site_id: number; site_key: string; consumer_addon_id: string; payment_id: string; refund_id: string | null;
    kind: PhisPaymentRecordKind; attempts: number; created_at: Date }>(`UPDATE phis.payment_record_tasks t
    SET lease_token = $1, lease_until = NOW() + make_interval(secs => $2)
    FROM phis.payments p, phis.sites s
    WHERE p.id = t.payment_id AND s.id = t.site_id AND t.id IN (
      SELECT id FROM phis.payment_record_tasks
      WHERE state = 'pending' AND next_attempt_at <= NOW() AND (lease_until IS NULL OR lease_until <= NOW()) AND kind = ANY($4::text[])
      ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
    RETURNING t.id::text, t.site_id, s.key AS site_key, p.consumer_addon_id, t.payment_id::text, t.refund_id::text, t.kind, t.attempts, t.created_at`,
  [token, leaseSeconds, limit, kinds]);
  return rows.map(row => ({ id: row.id, siteId: row.site_id, siteKey: row.site_key, consumerAddonId: row.consumer_addon_id, paymentId: row.payment_id,
    refundId: row.refund_id, kind: row.kind, attempts: row.attempts, createdAt: row.created_at.toISOString(), leaseToken: token }));
}

/**
 * What became of one attempt. `done`: nothing is left to collect. `retry`: asked again at `next`, counting
 * an attempt where the Provider answered (`counted`); `failed`: given up, with the reason. Only the run that
 * holds the lease writes.
 */
export async function finishPhisPaymentRecordTask(db: Db, task: Pick<PhisPaymentRecordTask, "id" | "leaseToken">,
  outcome: { state: "done" } | { state: "retry"; next: Date; counted: boolean; error: string | null } | { state: "failed"; error: string }) {
  await db.query(`UPDATE phis.payment_record_tasks SET lease_token = NULL, lease_until = NULL, state = $3,
      attempts = attempts + CASE WHEN $4::boolean THEN 1 ELSE 0 END, next_attempt_at = COALESCE($5::timestamptz, next_attempt_at),
      last_error = $6, updated_at = NOW()
    WHERE id = $1::bigint AND lease_token = $2`,
  [task.id, task.leaseToken, outcome.state === "retry" ? "pending" : outcome.state, outcome.state !== "done" && (outcome.state === "failed" || outcome.counted),
    outcome.state === "retry" ? outcome.next : null, outcome.state === "done" ? null : outcome.error]);
}

/** Starts a task that was given up again from its first retry (`phis billing documents retry`). */
export async function retryPhisPaymentRecordTasks(db: Db, siteId: number, paymentId: string, kind: PhisPaymentRecordKind): Promise<number> {
  const { rowCount } = await db.query(`UPDATE phis.payment_record_tasks SET state = 'pending', attempts = 0, next_attempt_at = NOW(), created_at = NOW(),
      last_error = NULL, updated_at = NOW()
    WHERE site_id = $1 AND payment_id::text = $2 AND kind = $3 AND state = 'failed'`, [siteId, paymentId, kind]);
  return rowCount ?? 0;
}

type SettlementRow = {
  id: string; payment_id: string; refund_id: string | null; direction: "credit" | "debit"; provider_reference: string;
  gross_currency: string; gross_minor: string; settled_currency: string; settled_minor: string; fee_minor: string;
  withheld_tax_minor: string | null; net_minor: string; exchange_rate: string | null; available_at: Date | null; booked_at: Date; recorded_at: Date;
};

function settlementFromRow(row: SettlementRow): PhisPaymentSettlement {
  const settled = (minor: string) => ({ currency: row.settled_currency, minor });
  return {
    id: row.id, paymentId: row.payment_id, refundId: row.refund_id, direction: row.direction, reference: row.provider_reference,
    gross: { currency: row.gross_currency, minor: row.gross_minor }, settled: settled(row.settled_minor), fee: settled(row.fee_minor),
    withheldTax: row.withheld_tax_minor === null ? null : settled(row.withheld_tax_minor), net: settled(row.net_minor),
    // NUMERIC answers trailing zeros; the Provider's string had none it needed.
    exchangeRate: row.exchange_rate === null ? null : row.exchange_rate.replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, ""),
    availableAt: row.available_at?.toISOString() ?? null, bookedAt: row.booked_at.toISOString(), recordedAt: row.recorded_at.toISOString(),
  };
}

/** Oldest first, as booked. */
export async function listPhisPaymentSettlements(db: Db, siteId: number, paymentId: string): Promise<PhisPaymentSettlement[]> {
  const { rows } = await db.query<SettlementRow>(`SELECT id::text, payment_id::text, refund_id::text, direction, provider_reference, gross_currency,
      gross_minor::text, settled_currency, settled_minor::text, fee_minor::text, withheld_tax_minor::text, net_minor::text, exchange_rate::text,
      available_at, booked_at, recorded_at
    FROM phis.payment_settlements WHERE site_id = $1 AND payment_id::text = $2 ORDER BY booked_at, recorded_at, id LIMIT 500`, [siteId, paymentId]);
  return rows.map(settlementFromRow);
}

/**
 * Records settlements as the Provider reported them, each once by its reference per profile; a record seen
 * before is never rewritten. The caller has checked the sums. Answers how many were new.
 */
export async function insertPhisPaymentSettlements(db: Db, input: {
  siteId: number; profileKey: string; paymentId: string;
  records: readonly (Omit<PhisPaymentSettlement, "id" | "paymentId" | "recordedAt">)[];
}): Promise<number> {
  let inserted = 0;
  for (const record of input.records) {
    const { rowCount } = await db.query(`INSERT INTO phis.payment_settlements (id, site_id, profile_key, payment_id, refund_id, direction, provider_reference,
        gross_currency, gross_minor, settled_currency, settled_minor, fee_minor, withheld_tax_minor, net_minor, exchange_rate, available_at, booked_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10, $11::bigint, $12::bigint, $13::bigint, $14::bigint, $15::numeric, $16, $17)
      ON CONFLICT (site_id, profile_key, provider_reference) DO NOTHING`,
    [randomUUID(), input.siteId, input.profileKey, input.paymentId, record.refundId, record.direction, record.reference,
      record.gross.currency, record.gross.minor, record.settled.currency, record.settled.minor, record.fee.minor, record.withheldTax?.minor ?? null,
      record.net.minor, record.exchangeRate, record.availableAt, record.bookedAt]);
    inserted += rowCount ?? 0;
  }
  return inserted;
}

/** Which of the payment's capture (`null`) and refunds have at least one settlement recorded. */
export async function listSettledPhisPaymentParts(db: Db, paymentId: string): Promise<(string | null)[]> {
  const { rows } = await db.query<{ refund_id: string | null }>(`SELECT DISTINCT refund_id::text FROM phis.payment_settlements WHERE payment_id::text = $1`, [paymentId]);
  return rows.map(row => row.refund_id);
}
