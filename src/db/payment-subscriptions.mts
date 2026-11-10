import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { PhisPaymentSubscriptionPeriod } from "@phis/contracts/payments";
import { PHIS_PAYMENT_LEASE_SECONDS } from "../lib/constants/payments.ts";
import type { PhisPaymentScope, PhisStoredPaymentSubscription } from "../lib/payments/types.ts";

type Db = Pick<PoolClient, "query">;
type SubscriptionRow = {
  site_id: number; consumer_addon_id: string; record: PhisStoredPaymentSubscription["record"]; request: Record<string, unknown>;
  anchor_at: Date | null; lease_token: string | null;
};
function fromRow(row: SubscriptionRow): PhisStoredPaymentSubscription {
  return { siteId: row.site_id, consumerAddonId: row.consumer_addon_id, record: row.record, request: row.request,
    anchorAt: row.anchor_at?.toISOString() ?? null, leaseToken: row.lease_token };
}

export type PhisStoredPaymentSubscriptionPeriod = {
  record: PhisPaymentSubscriptionPeriod;
  /** How many charges the schedule has made for this period; a customer's own payment is not one. */
  attempts: number;
};

/** Also serializes a first create, before there is a row to lock. */
export async function findPhisPaymentSubscriptionIdempotency(db: Db, scope: PhisPaymentScope, key: string): Promise<PhisStoredPaymentSubscription | null> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["payment-subscription", scope.siteId, scope.consumerAddonId, key])]);
  const { rows } = await db.query<SubscriptionRow>(`SELECT * FROM phis.payment_subscriptions
    WHERE site_id = $1 AND consumer_addon_id = $2 AND idempotency_key = $3`, [scope.siteId, scope.consumerAddonId, key]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** False when the consumer already has a subscription under this reference that has not ended. */
export async function insertPhisPaymentSubscription(db: Db, subscription: PhisStoredPaymentSubscription, idempotencyKey: string): Promise<boolean> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [JSON.stringify(["payment-subscription-reference", subscription.siteId, subscription.consumerAddonId, subscription.record.reference])]);
  const live = await db.query(`SELECT 1 FROM phis.payment_subscriptions WHERE site_id = $1 AND consumer_addon_id = $2
    AND record->>'reference' = $3 AND record->>'status' <> 'canceled' LIMIT 1`,
    [subscription.siteId, subscription.consumerAddonId, subscription.record.reference]);
  if (live.rowCount) return false;
  await db.query(`INSERT INTO phis.payment_subscriptions (id, site_id, consumer_addon_id, profile_key, idempotency_key, request, record)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [subscription.record.id, subscription.siteId, subscription.consumerAddonId, subscription.record.profileKey, idempotencyKey,
      JSON.stringify(subscription.request), JSON.stringify(subscription.record)]);
  return true;
}

export async function readPhisPaymentSubscription(db: Db, siteId: number, id: string, consumerAddonId: string | null = null, lock = false): Promise<PhisStoredPaymentSubscription | null> {
  const { rows } = await db.query<SubscriptionRow>(`SELECT * FROM phis.payment_subscriptions WHERE site_id = $1 AND id::text = $2
    AND ($3::text IS NULL OR consumer_addon_id = $3) ${lock ? "FOR UPDATE" : ""}`, [siteId, id, consumerAddonId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/**
 * Writes the record and says so to the consumer. The lease is left alone: it belongs to the scheduler
 * run that holds it, and a payment's outcome arriving in the middle of that run must not end it.
 */
export async function writePhisPaymentSubscription(db: Db, subscription: PhisStoredPaymentSubscription, periodIndex: number | null) {
  await db.query(`UPDATE phis.payment_subscriptions SET record = $2::jsonb, anchor_at = $3, next_charge_at = $4, updated_at = NOW() WHERE id = $1`,
    [subscription.record.id, JSON.stringify(subscription.record), subscription.anchorAt, subscription.record.nextChargeAt]);
  await db.query(`INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, subject_kind, subscription_id, payload)
    VALUES ($1, $2, 'payment.changed', 'subscription', $3, $4::jsonb)`,
    [subscription.siteId, subscription.consumerAddonId, subscription.record.id, JSON.stringify({ subscriptionId: subscription.record.id,
      reference: subscription.record.reference, version: subscription.record.version, periodIndex })]);
}

/** Whether a subscription that has not ended is charged to this stored method. */
export async function isPhisPaymentStoredMethodInUse(db: Db, storedMethodId: string): Promise<boolean> {
  const { rowCount } = await db.query(`SELECT 1 FROM phis.payment_subscriptions
    WHERE record->>'storedMethodId' = $1 AND record->>'status' <> 'canceled' LIMIT 1`, [storedMethodId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Moves the payer's subscriptions from stored methods a Provider has replaced onto the one that replaced
 * them, where the Provider keeps one per payer. Returns what was moved, for the caller to say so.
 */
export async function listPhisPaymentSubscriptionsOnMethod(db: Db, storedMethodId: string): Promise<PhisStoredPaymentSubscription[]> {
  return (await db.query<SubscriptionRow>(`SELECT * FROM phis.payment_subscriptions
    WHERE record->>'storedMethodId' = $1 AND record->>'status' <> 'canceled' ORDER BY created_at, id FOR UPDATE`, [storedMethodId])).rows.map(fromRow);
}

/** Creates the period where it does not exist yet; the key is what makes it exist once. */
export async function ensurePhisPaymentSubscriptionPeriod(db: Db, period: PhisPaymentSubscriptionPeriod): Promise<PhisStoredPaymentSubscriptionPeriod> {
  await db.query(`INSERT INTO phis.payment_subscription_periods (subscription_id, period_index, record)
    VALUES ($1, $2, $3::jsonb) ON CONFLICT (subscription_id, period_index) DO NOTHING`, [period.subscriptionId, period.index, JSON.stringify(period)]);
  return (await readPhisPaymentSubscriptionPeriod(db, period.subscriptionId, period.index, true))!;
}

export async function readPhisPaymentSubscriptionPeriod(db: Db, subscriptionId: string, index: number, lock = false): Promise<PhisStoredPaymentSubscriptionPeriod | null> {
  const { rows } = await db.query<{ record: PhisPaymentSubscriptionPeriod; attempts: number }>(`SELECT record, attempts FROM phis.payment_subscription_periods
    WHERE subscription_id::text = $1 AND period_index = $2 ${lock ? "FOR UPDATE" : ""}`, [subscriptionId, index]);
  return rows[0] ? { record: rows[0].record, attempts: rows[0].attempts } : null;
}

export async function listPhisPaymentSubscriptionPeriods(db: Db, subscriptionId: string): Promise<PhisPaymentSubscriptionPeriod[]> {
  return (await db.query<{ record: PhisPaymentSubscriptionPeriod }>(`SELECT record FROM phis.payment_subscription_periods
    WHERE subscription_id::text = $1 ORDER BY period_index DESC LIMIT 500`, [subscriptionId])).rows.map(row => row.record);
}

export async function writePhisPaymentSubscriptionPeriod(db: Db, period: PhisStoredPaymentSubscriptionPeriod) {
  await db.query("UPDATE phis.payment_subscription_periods SET record = $3::jsonb, attempts = $4 WHERE subscription_id = $1 AND period_index = $2",
    [period.record.subscriptionId, period.record.index, JSON.stringify(period.record), period.attempts]);
}

/**
 * The subscriptions the schedule owes something now, each taken under a lease so that a second run
 * leaves them alone. `SKIP LOCKED` keeps two instances from waiting on each other for the same rows.
 */
export async function claimDuePhisPaymentSubscriptions(db: Db, limit: number): Promise<(PhisStoredPaymentSubscription & { siteKey: string })[]> {
  const token = randomUUID();
  const { rows } = await db.query<SubscriptionRow & { site_key: string }>(`UPDATE phis.payment_subscriptions s
    SET lease_token = $1, lease_until = NOW() + make_interval(secs => $2)
    FROM phis.sites site
    WHERE site.id = s.site_id AND s.id IN (
      SELECT id FROM phis.payment_subscriptions
      WHERE next_charge_at IS NOT NULL AND next_charge_at <= NOW() AND (lease_until IS NULL OR lease_until <= NOW())
      ORDER BY next_charge_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
    RETURNING s.*, site.key AS site_key`, [token, PHIS_PAYMENT_LEASE_SECONDS, limit]);
  return rows.map(row => ({ ...fromRow(row), siteKey: row.site_key }));
}

export async function releasePhisPaymentSubscription(db: Db, id: string, leaseToken: string) {
  await db.query("UPDATE phis.payment_subscriptions SET lease_token = NULL, lease_until = NULL WHERE id = $1 AND lease_token = $2", [id, leaseToken]);
}

/**
 * Puts off the schedule's next look at a subscription without changing anything a consumer reads: for a
 * run that could not act and has nothing to report.
 */
export async function postponePhisPaymentSubscription(db: Db, id: string, until: Date) {
  await db.query(`UPDATE phis.payment_subscriptions SET next_charge_at = $2, record = jsonb_set(record, '{nextChargeAt}', to_jsonb($3::text))
    WHERE id = $1 AND next_charge_at IS NOT NULL AND next_charge_at < $2`, [id, until, until.toISOString()]);
}
