import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PhisPaymentProfileDraft, PhisPaymentProviderProbe } from "@phis/contracts/payments";
import { withPoolTransaction } from "../lib/db-transaction.ts";
import { PHIS_PAYMENT_LEASE_SECONDS } from "../lib/constants/payments.ts";
import { PhisPaymentError, requirePhisPaymentReference } from "../lib/payments/validation.ts";
import type {
  PhisPaymentProfile, PhisPaymentReceipt, PhisPaymentScope, PhisStoredPayment, PhisStoredPaymentMethod,
  PhisStoredPaymentOperation, PhisStoredPaymentRefund,
} from "../lib/payments/types.ts";

type Db = Pick<PoolClient, "query">;
type PaymentRow = {
  site_id: number; consumer_addon_id: string; provider_key: string; merchant_identity: string;
  profile_revision: number; currency_exponent: number; binding: PhisStoredPayment["binding"];
  method_features: PhisStoredPayment["features"]; record: PhisStoredPayment["record"]; generation: string; lease_token: string | null; lease_until: Date | null;
};
function paymentFromRow(row: PaymentRow): PhisStoredPayment {
  return { siteId: row.site_id, consumerAddonId: row.consumer_addon_id, providerKey: row.provider_key,
    merchantIdentity: row.merchant_identity, profileRevision: row.profile_revision, currencyExponent: row.currency_exponent,
    // A payment written before stored methods existed was started by a customer and stored nothing.
    features: row.method_features, binding: row.binding, record: { ...row.record, initiator: row.record.initiator ?? "customer", storedMethodId: row.record.storedMethodId ?? null,
      subscriptionId: row.record.subscriptionId ?? null, periodIndex: row.record.periodIndex ?? null },
    generation: Number(row.generation), leaseToken: row.lease_token, leaseUntil: row.lease_until };
}

export async function readPhisPaymentProfile(db: Db, siteId: number, key: string, lock = false): Promise<PhisPaymentProfile | null> {
  const { rows } = await db.query<{
    draft: PhisPaymentProfileDraft; provider_addon_id: string; merchant_identity: string | null;
    revision: number; enabled: boolean; retired: boolean; probed_at: Date | null; methods: PhisPaymentProviderProbe["methods"] | null;
  }>(`SELECT * FROM phis.payment_profiles WHERE site_id = $1 AND key = $2 ${lock ? "FOR SHARE" : ""}`, [siteId, key]);
  const row = rows[0];
  return row ? { ...row.draft, siteId, providerAddonId: row.provider_addon_id, merchantIdentity: row.merchant_identity,
    revision: row.revision, enabled: row.enabled, retired: row.retired, probedAt: row.probed_at?.toISOString() ?? null, methods: row.methods } : null;
}

export async function listPhisPaymentProfiles(db: Db, siteId: number): Promise<PhisPaymentProfile[]> {
  const { rows } = await db.query<{ key: string }>("SELECT key FROM phis.payment_profiles WHERE site_id = $1 ORDER BY key", [siteId]);
  const result: PhisPaymentProfile[] = [];
  for (const row of rows) { const profile = await readPhisPaymentProfile(db, siteId, row.key); if (profile) result.push(profile); }
  return result;
}

export async function writePhisPaymentProfile(pool: Pool, siteId: number, providerAddonId: string, draft: PhisPaymentProfileDraft, replace: boolean) {
  return withPoolTransaction(pool, async db => {
    // Serializes add/set/retire even before the profile row exists.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["payment-profile", siteId, draft.key])]);
    const previous = await readPhisPaymentProfile(db, siteId, draft.key, true);
    if (!!previous !== replace) throw new PhisPaymentError("invalid_input", previous ? "Payment profile already exists." : "Payment profile does not exist.");
    if (previous && (previous.providerKey !== draft.providerKey || previous.providerAddonId !== providerAddonId || previous.mode !== draft.mode || previous.retired)) {
      throw new PhisPaymentError("invalid_input", "Create a new profile for another provider, merchant or mode; retired profiles cannot be reused.");
    }
    await db.query(`INSERT INTO phis.payment_profiles (site_id, key, provider_addon_id, draft)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (site_id, key) DO UPDATE SET draft = EXCLUDED.draft,
        revision = phis.payment_profiles.revision + 1, enabled = FALSE, probed_at = NULL, methods = NULL`,
      [siteId, draft.key, providerAddonId, JSON.stringify(draft)]);
    return (await readPhisPaymentProfile(db, siteId, draft.key))!;
  });
}

export async function recordPhisPaymentProfileProbe(db: Db, profile: PhisPaymentProfile, merchantIdentity: string, mode: "test" | "live", methods: PhisPaymentProviderProbe["methods"] = []) {
  requirePhisPaymentReference(merchantIdentity);
  if (mode !== profile.mode || (profile.merchantIdentity !== null && profile.merchantIdentity !== merchantIdentity)) throw new PhisPaymentError("profile_unavailable");
  const result = await db.query(`UPDATE phis.payment_profiles SET merchant_identity = $4, probed_at = NOW(), methods = $5::jsonb
    WHERE site_id = $1 AND key = $2 AND revision = $3 AND NOT retired`, [profile.siteId, profile.key, profile.revision, merchantIdentity, JSON.stringify(methods)]);
  if (!result.rowCount) throw new PhisPaymentError("profile_unavailable");
}

export async function setPhisPaymentProfileEnabled(db: Db, profile: PhisPaymentProfile, enabled: boolean, retire = false) {
  const result = await db.query(`UPDATE phis.payment_profiles SET enabled = $4, retired = retired OR $5, revision = revision + 1
    WHERE site_id = $1 AND key = $2 AND revision = $3
      AND (NOT $4 OR (merchant_identity IS NOT NULL AND probed_at IS NOT NULL AND NOT retired))`,
    [profile.siteId, profile.key, profile.revision, enabled, retire]);
  if (!result.rowCount) throw new PhisPaymentError("profile_unavailable");
}

export async function readPhisPayment(db: Db, siteId: number, id: string, consumerAddonId: string | null = null, lock = false): Promise<PhisStoredPayment | null> {
  const { rows } = await db.query<PaymentRow>(`SELECT * FROM phis.payments WHERE site_id = $1 AND id::text = $2
    AND ($3::text IS NULL OR consumer_addon_id = $3) ${lock ? "FOR UPDATE" : ""}`, [siteId, id, consumerAddonId]);
  return rows[0] ? paymentFromRow(rows[0]) : null;
}

export async function findPhisPaymentForNotification(db: Db, siteId: number, profileKey: string, reference: string): Promise<PhisStoredPayment | null> {
  const { rows } = await db.query<PaymentRow>(`SELECT * FROM phis.payments WHERE site_id = $1 AND profile_key = $2
    AND (id::text = $3 OR binding->>'reference' = $3) LIMIT 2`, [siteId, profileKey, reference]);
  return rows.length === 1 ? paymentFromRow(rows[0]!) : null;
}

export async function readPhisPaymentOperation(db: Db, id: string, scope?: PhisPaymentScope): Promise<PhisStoredPaymentOperation | null> {
  const { rows } = await db.query<PhisStoredPaymentOperation>(`SELECT record, command, request FROM phis.payment_operations
    WHERE id::text = $1 AND ($2::smallint IS NULL OR site_id = $2) AND ($3::text IS NULL OR consumer_addon_id = $3)`,
    [id, scope?.siteId ?? null, scope?.consumerAddonId ?? null]);
  return rows[0] ?? null;
}

export async function readPhisPaymentRefund(db: Db, id: string, scope: PhisPaymentScope): Promise<PhisStoredPaymentRefund | null> {
  const { rows } = await db.query<{ record: PhisStoredPaymentRefund["record"]; operation_id: string | null; binding: PhisStoredPaymentRefund["binding"] }>(
    `SELECT r.record, r.operation_id, r.binding FROM phis.payment_refunds r JOIN phis.payments p ON p.id = r.payment_id
     WHERE r.id::text = $1 AND p.site_id = $2 AND p.consumer_addon_id = $3`, [id, scope.siteId, scope.consumerAddonId]);
  return rows[0] ? { record: rows[0].record, operationId: rows[0].operation_id, binding: rows[0].binding } : null;
}

export async function listPhisPaymentOperations(db: Db, paymentId: string): Promise<PhisStoredPaymentOperation[]> {
  return (await db.query<PhisStoredPaymentOperation>("SELECT record, command, request FROM phis.payment_operations WHERE payment_id = $1 ORDER BY first_possible_submission_at, id", [paymentId])).rows;
}
export async function listPhisPaymentRefunds(db: Db, paymentId: string): Promise<PhisStoredPaymentRefund[]> {
  return (await db.query<{ record: PhisStoredPaymentRefund["record"]; operation_id: string | null; binding: PhisStoredPaymentRefund["binding"] }>(
    "SELECT record, operation_id, binding FROM phis.payment_refunds WHERE payment_id = $1 ORDER BY id", [paymentId])).rows
    .map(row => ({ record: row.record, operationId: row.operation_id, binding: row.binding }));
}

export async function findPhisPaymentIdempotency(db: Db, scope: PhisPaymentScope, action: string, key: string): Promise<PhisStoredPaymentOperation | null> {
  // Also serializes a first create before there is any payment row to lock.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["payment-operation", scope.siteId, scope.consumerAddonId, action, key])]);
  return (await db.query<PhisStoredPaymentOperation>(`SELECT record, command, request FROM phis.payment_operations
    WHERE site_id = $1 AND consumer_addon_id = $2 AND action = $3 AND idempotency_key = $4`, [scope.siteId, scope.consumerAddonId, action, key])).rows[0] ?? null;
}

export async function insertPhisPayment(db: Db, payment: PhisStoredPayment) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["payment-reference", payment.siteId, payment.consumerAddonId, payment.record.reference])]);
  const active = await db.query(`SELECT id FROM phis.payments WHERE site_id = $1 AND consumer_addon_id = $2 AND record->>'reference' = $3
    AND (record->>'status' NOT IN ('failed','expired','canceled') OR (record->>'reconciliationRequired')::boolean) LIMIT 1`,
    [payment.siteId, payment.consumerAddonId, payment.record.reference]);
  if (active.rowCount) throw new PhisPaymentError("active_attempt_exists");
  await db.query(`INSERT INTO phis.payments (id, site_id, consumer_addon_id, profile_key, provider_key, merchant_identity,
    profile_revision, currency_exponent, method_features, record) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
    [payment.record.id, payment.siteId, payment.consumerAddonId, payment.record.profileKey, payment.providerKey,
      payment.merchantIdentity, payment.profileRevision, payment.currencyExponent, JSON.stringify(payment.features), JSON.stringify(payment.record)]);
}

export async function insertPhisPaymentOperation(db: Db, scope: PhisPaymentScope, key: string, operation: PhisStoredPaymentOperation) {
  await db.query(`INSERT INTO phis.payment_operations (id, payment_id, site_id, consumer_addon_id, action, idempotency_key, request, command, record)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)`,
    [operation.record.id, operation.record.paymentId, scope.siteId, scope.consumerAddonId, operation.record.action, key,
      JSON.stringify(operation.request), JSON.stringify(operation.command), JSON.stringify(operation.record)]);
}
export async function writePhisPaymentOperation(db: Db, operation: PhisStoredPaymentOperation) {
  await db.query("UPDATE phis.payment_operations SET record = $2::jsonb WHERE id = $1", [operation.record.id, JSON.stringify(operation.record)]);
}
export async function writePhisPaymentRefund(db: Db, refund: PhisStoredPaymentRefund) {
  await db.query(`INSERT INTO phis.payment_refunds (id, payment_id, operation_id, remote_reference, binding, record)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb) ON CONFLICT (id) DO UPDATE SET
      remote_reference = EXCLUDED.remote_reference, binding = EXCLUDED.binding, record = EXCLUDED.record`,
    [refund.record.id, refund.record.paymentId, refund.operationId, refund.binding?.reference ?? null,
      JSON.stringify(refund.binding), JSON.stringify(refund.record)]);
}

/** Called under the payment lock. A lease protects ordering; it never authorizes an external replay. */
export async function claimPhisPayment(db: Db, payment: PhisStoredPayment): Promise<boolean> {
  const result = await db.query<{ generation: string; lease_token: string; lease_until: Date }>(`UPDATE phis.payments
    SET generation = generation + 1, lease_token = $2, lease_until = NOW() + make_interval(secs => $3)
    WHERE id = $1 AND (lease_until IS NULL OR lease_until <= NOW()) RETURNING generation, lease_token, lease_until`,
    [payment.record.id, randomUUID(), PHIS_PAYMENT_LEASE_SECONDS]);
  const row = result.rows[0];
  if (!row) return false;
  payment.generation = Number(row.generation); payment.leaseToken = row.lease_token; payment.leaseUntil = row.lease_until;
  return true;
}

export async function writePhisPayment(db: Db, payment: PhisStoredPayment, event: { operationId: string | null; refundId: string | null } | null) {
  await db.query(`UPDATE phis.payments SET record = $2::jsonb, binding = $3::jsonb, lease_token = NULL, lease_until = NULL, updated_at = NOW() WHERE id = $1`,
    [payment.record.id, JSON.stringify(payment.record), JSON.stringify(payment.binding)]);
  if (event) {
    await db.query(`INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, subject_kind, payment_id, payload)
      VALUES ($1, $2, 'payment.changed', 'payment', $3, $4::jsonb)`,
      [payment.siteId, payment.consumerAddonId, payment.record.id, JSON.stringify({ paymentId: payment.record.id, reference: payment.record.reference,
        version: payment.record.version, operationId: event.operationId, refundId: event.refundId })]);
  }
}

export async function claimPhisPaymentReceipt(pool: Pool, payment: PhisStoredPayment, deliveryId: string): Promise<PhisPaymentReceipt | "duplicate" | "busy"> {
  return withPoolTransaction(pool, async db => {
    const token = randomUUID();
    const result = await db.query(`INSERT INTO phis.payment_notification_receipts (site_id, profile_key, delivery_id, payment_id, claim_token, claim_until)
      VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6))
      ON CONFLICT (site_id, profile_key, delivery_id) DO UPDATE SET claim_token = EXCLUDED.claim_token, claim_until = EXCLUDED.claim_until
      WHERE NOT phis.payment_notification_receipts.processed AND phis.payment_notification_receipts.claim_until <= NOW()
        AND phis.payment_notification_receipts.payment_id = EXCLUDED.payment_id RETURNING delivery_id`,
      [payment.siteId, payment.record.profileKey, deliveryId, payment.record.id, token, PHIS_PAYMENT_LEASE_SECONDS]);
    if (result.rowCount) return { profileKey: payment.record.profileKey, deliveryId, token };
    const receipt = await db.query<{ processed: boolean; payment_id: string }>(`SELECT processed, payment_id FROM phis.payment_notification_receipts
      WHERE site_id = $1 AND profile_key = $2 AND delivery_id = $3`, [payment.siteId, payment.record.profileKey, deliveryId]);
    return receipt.rows[0]?.processed && receipt.rows[0].payment_id === payment.record.id ? "duplicate" : "busy";
  });
}

export async function finishPhisPaymentReceipt(db: Db, siteId: number, receipt: PhisPaymentReceipt) {
  const result = await db.query(`UPDATE phis.payment_notification_receipts SET processed = TRUE, processed_at = NOW()
    WHERE site_id = $1 AND profile_key = $2 AND delivery_id = $3 AND claim_token = $4 AND NOT processed AND claim_until > NOW()`,
    [siteId, receipt.profileKey, receipt.deliveryId, receipt.token]);
  if (!result.rowCount) throw new PhisPaymentError("provider_unavailable");
}

export async function releasePhisPaymentReceipt(db: Db, siteId: number, receipt: PhisPaymentReceipt) {
  await db.query(`UPDATE phis.payment_notification_receipts SET claim_until = NOW() WHERE site_id = $1 AND profile_key = $2
    AND delivery_id = $3 AND claim_token = $4 AND NOT processed`, [siteId, receipt.profileKey, receipt.deliveryId, receipt.token]);
}

type StoredMethodRow = {
  site_id: number; consumer_addon_id: string; method_features: PhisStoredPaymentMethod["features"];
  binding: PhisStoredPaymentMethod["binding"]; record: PhisStoredPaymentMethod["record"];
};
function storedMethodFromRow(row: StoredMethodRow): PhisStoredPaymentMethod {
  return { siteId: row.site_id, consumerAddonId: row.consumer_addon_id, features: row.method_features, binding: row.binding, record: row.record };
}

export async function insertPhisPaymentStoredMethod(db: Db, method: PhisStoredPaymentMethod, setupKey: string | null = null) {
  await db.query(`INSERT INTO phis.payment_stored_methods (id, site_id, consumer_addon_id, profile_key, payer_reference, method_features, binding, record, setup_key)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
    [method.record.id, method.siteId, method.consumerAddonId, method.record.profileKey, method.record.payerReference,
      JSON.stringify(method.features), JSON.stringify(method.binding), JSON.stringify(method.record), setupKey]);
}

/**
 * The stored method a set-up without payment made under this key, with the hosted page it was answered
 * with. Also serializes a first request, before there is a row to find.
 */
export async function findPhisPaymentStoredMethodSetup(db: Db, scope: PhisPaymentScope, key: string): Promise<{ method: PhisStoredPaymentMethod; checkout: unknown } | null> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["payment-method-setup", scope.siteId, scope.consumerAddonId, key])]);
  const { rows } = await db.query<StoredMethodRow & { setup_checkout: unknown }>(`SELECT * FROM phis.payment_stored_methods
    WHERE site_id = $1 AND consumer_addon_id = $2 AND setup_key = $3`, [scope.siteId, scope.consumerAddonId, key]);
  return rows[0] ? { method: storedMethodFromRow(rows[0]), checkout: rows[0].setup_checkout } : null;
}

export async function writePhisPaymentStoredMethodSetupCheckout(db: Db, id: string, checkout: unknown) {
  await db.query("UPDATE phis.payment_stored_methods SET setup_checkout = $2::jsonb WHERE id = $1", [id, JSON.stringify(checkout)]);
}

export async function readPhisPaymentStoredMethod(db: Db, siteId: number, id: string, consumerAddonId: string | null = null, lock = false): Promise<PhisStoredPaymentMethod | null> {
  const { rows } = await db.query<StoredMethodRow>(`SELECT * FROM phis.payment_stored_methods WHERE site_id = $1 AND id::text = $2
    AND ($3::text IS NULL OR consumer_addon_id = $3) ${lock ? "FOR UPDATE" : ""}`, [siteId, id, consumerAddonId]);
  return rows[0] ? storedMethodFromRow(rows[0]) : null;
}

export async function listPhisPaymentStoredMethods(db: Db, scope: PhisPaymentScope, profileKey: string, payerReference: string): Promise<PhisStoredPaymentMethod[]> {
  return (await db.query<StoredMethodRow>(`SELECT * FROM phis.payment_stored_methods
    WHERE site_id = $1 AND consumer_addon_id = $2 AND profile_key = $3 AND payer_reference = $4 ORDER BY created_at DESC, id`,
    [scope.siteId, scope.consumerAddonId, profileKey, payerReference])).rows.map(storedMethodFromRow);
}

/** Every record the reference names: one means stored twice is two records with one reference. */
export async function findPhisPaymentStoredMethodsForNotification(db: Db, siteId: number, profileKey: string, reference: string): Promise<PhisStoredPaymentMethod[]> {
  const { rows } = await db.query<StoredMethodRow>(`SELECT * FROM phis.payment_stored_methods WHERE site_id = $1 AND profile_key = $2
    AND (id::text = $3 OR binding->>'reference' = $3) ORDER BY created_at, id LIMIT 20`, [siteId, profileKey, reference]);
  return rows.map(storedMethodFromRow);
}

export async function writePhisPaymentStoredMethod(db: Db, method: PhisStoredPaymentMethod) {
  await db.query("UPDATE phis.payment_stored_methods SET record = $2::jsonb, binding = $3::jsonb, updated_at = NOW() WHERE id = $1",
    [method.record.id, JSON.stringify(method.record), JSON.stringify(method.binding)]);
}

/**
 * Where a Provider keeps one stored method per payer, a new one has replaced the others there already.
 * The records follow: every other active method of the same payer, profile and method ends as revoked.
 */
export async function revokeSupersededPhisPaymentStoredMethods(db: Db, method: PhisStoredPaymentMethod): Promise<string[]> {
  return (await db.query<{ id: string }>(`UPDATE phis.payment_stored_methods
    SET record = record || jsonb_build_object('status', 'revoked', 'version', (record->>'version')::int + 1), updated_at = NOW()
    WHERE site_id = $1 AND consumer_addon_id = $2 AND profile_key = $3 AND payer_reference = $4 AND id <> $5
      AND record->>'status' = 'active' AND (record->>'methodKey') IS NOT DISTINCT FROM $6 RETURNING id`,
    [method.siteId, method.consumerAddonId, method.record.profileKey, method.record.payerReference, method.record.id, method.record.methodKey])).rows.map(row => row.id);
}

export async function listPhisPaymentRecoveryCandidates(db: Db, limit: number) {
  return (await db.query<{ id: string; site_id: number; key: string; consumer_addon_id: string }>(`SELECT p.id, p.site_id, s.key, p.consumer_addon_id
    FROM phis.payments p JOIN phis.sites s ON s.id = p.site_id
    WHERE (p.record->>'reconciliationRequired')::boolean OR EXISTS (
      SELECT 1 FROM phis.payment_operations o WHERE o.payment_id = p.id AND o.record->>'state' IN ('reserved','pending','indeterminate'))
    ORDER BY p.updated_at, p.id LIMIT $1`, [limit])).rows;
}
