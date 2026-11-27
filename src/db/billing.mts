import type { PoolClient } from "pg";
import { PhisSupportTicketStatus } from "@phis/contracts/support";
import type {
  PhisBillingDocument, PhisBillingDocumentContent, PhisBillingDocumentKind, PhisBillingNumberedDocumentKind, PhisBillingNumberSeriesReset,
  PhisBillingPaymentState,
} from "@phis/contracts/billing";

type Db = Pick<PoolClient, "query">;

/**
 * Core's billing documents and number series (`billing:v1`; DB.md, billing documents). Every statement of
 * them; what they mean is `src/lib/billing/`. Not `server-only`: the operator's CLI reads the same rows.
 */

/** The kinds as bits, as `billing_document_sources.kinds` and `billing_number_series.kinds` store them. */
export const PHIS_BILLING_KIND_BITS: Readonly<Record<PhisBillingDocumentKind, number>> = {
  invoice: 1, "credit-note": 2, reminder: 4, receipt: 8, confirmation: 16,
};

export function phisBillingKindsToBits(kinds: readonly PhisBillingDocumentKind[]): number {
  return kinds.reduce((bits, kind) => bits | PHIS_BILLING_KIND_BITS[kind], 0);
}

export function phisBillingKindsFromBits(bits: number): PhisBillingDocumentKind[] {
  return (Object.keys(PHIS_BILLING_KIND_BITS) as PhisBillingDocumentKind[]).filter(kind => (bits & PHIS_BILLING_KIND_BITS[kind]) !== 0);
}

// ---- sources: the operator's allow-list ----

export type PhisBillingSourceRow = { addonId: string; kinds: PhisBillingDocumentKind[]; grantedAt: string };

export async function listPhisBillingSources(db: Db, siteId: number): Promise<PhisBillingSourceRow[]> {
  const { rows } = await db.query<{ addon_id: string; kinds: number; granted_at: Date }>(
    "SELECT addon_id, kinds, granted_at FROM phis.billing_document_sources WHERE site_id = $1 ORDER BY addon_id", [siteId]);
  return rows.map(row => ({ addonId: row.addon_id, kinds: phisBillingKindsFromBits(row.kinds), grantedAt: row.granted_at.toISOString() }));
}

/** The kinds an Add-on may issue on a Site; `[]` where the operator allowed it none. */
export async function readPhisBillingSourceKinds(db: Db, siteId: number, addonId: string): Promise<PhisBillingDocumentKind[]> {
  const { rows } = await db.query<{ kinds: number }>("SELECT kinds FROM phis.billing_document_sources WHERE site_id = $1 AND addon_id = $2", [siteId, addonId]);
  return rows[0] ? phisBillingKindsFromBits(rows[0].kinds) : [];
}

/** Allows a source exactly these kinds, replacing what it was allowed before. */
export async function allowPhisBillingSource(db: Db, siteId: number, addonId: string, kinds: readonly PhisBillingDocumentKind[]) {
  await db.query(`INSERT INTO phis.billing_document_sources (site_id, addon_id, kinds) VALUES ($1, $2, $3)
    ON CONFLICT (site_id, addon_id) DO UPDATE SET kinds = EXCLUDED.kinds, granted_at = NOW()`, [siteId, addonId, phisBillingKindsToBits(kinds)]);
}

/** Takes the leave back; what the source issued stays, issued. */
export async function denyPhisBillingSource(db: Db, siteId: number, addonId: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM phis.billing_document_sources WHERE site_id = $1 AND addon_id = $2", [siteId, addonId]);
  return (rowCount ?? 0) > 0;
}

// ---- number series ----

export type PhisStoredBillingSeries = {
  id: string; siteId: number; key: string; label: string; template: string; reset: PhisBillingNumberSeriesReset;
  kinds: PhisBillingNumberedDocumentKind[]; sources: string[]; flags: number; createdAt: string; closedAt: string | null;
};

type SeriesRow = { id: string; site_id: number; key: string; label: string; template: string; reset: PhisBillingNumberSeriesReset; kinds: number;
  flags: number; created_at: Date; closed_at: Date | null; sources: string[] | null };
const SERIES_COLUMNS = `s.id::text, s.site_id, s.key, s.label, s.template, s.reset, s.kinds, s.flags, s.created_at, s.closed_at,
  ARRAY(SELECT x.addon_id FROM phis.billing_series_sources x WHERE x.series_id = s.id ORDER BY x.addon_id) AS sources`;
const seriesFromRow = (row: SeriesRow): PhisStoredBillingSeries => ({
  id: row.id, siteId: row.site_id, key: row.key, label: row.label, template: row.template, reset: row.reset,
  kinds: phisBillingKindsFromBits(row.kinds) as PhisBillingNumberedDocumentKind[], sources: row.sources ?? [], flags: row.flags,
  createdAt: row.created_at.toISOString(), closedAt: row.closed_at?.toISOString() ?? null,
});

/** A Site's series, newest first; `open` only those that number, `source` only those it may number from. */
export async function listPhisBillingSeries(db: Db, siteId: number, filter: { open?: boolean; source?: string } = {}): Promise<PhisStoredBillingSeries[]> {
  const { rows } = await db.query<SeriesRow>(`SELECT ${SERIES_COLUMNS} FROM phis.billing_number_series s
    WHERE s.site_id = $1 AND (NOT $2::boolean OR (s.flags & 1) = 0)
      AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM phis.billing_series_sources x WHERE x.series_id = s.id AND x.addon_id = $3))
    ORDER BY s.created_at DESC, s.id DESC LIMIT 500`, [siteId, filter.open === true, filter.source ?? null]);
  return rows.map(seriesFromRow);
}

export async function readPhisBillingSeries(db: Db, siteId: number, id: string, lock = false): Promise<PhisStoredBillingSeries | null> {
  const { rows } = await db.query<SeriesRow>(`SELECT ${SERIES_COLUMNS} FROM phis.billing_number_series s
    WHERE s.site_id = $1 AND s.id::text = $2 ${lock ? "FOR UPDATE OF s" : ""}`, [siteId, id]);
  return rows[0] ? seriesFromRow(rows[0]) : null;
}

/** The open series of a key, locked for the issue that numbers from it; `null` where there is none. */
export async function readOpenPhisBillingSeriesByKey(db: Db, siteId: number, key: string, lock = false): Promise<PhisStoredBillingSeries | null> {
  const { rows } = await db.query<SeriesRow>(`SELECT ${SERIES_COLUMNS} FROM phis.billing_number_series s
    WHERE s.site_id = $1 AND s.key = $2 AND (s.flags & 1) = 0 ${lock ? "FOR UPDATE OF s" : ""}`, [siteId, key]);
  return rows[0] ? seriesFromRow(rows[0]) : null;
}

/** Serializes the writes of one key's series, before any row of it is locked. */
export async function lockPhisBillingSeriesKey(db: Db, siteId: number, key: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["billing-series", siteId, key])]);
}

export async function insertPhisBillingSeries(db: Db, series: Omit<PhisStoredBillingSeries, "createdAt" | "closedAt" | "flags">) {
  await db.query(`INSERT INTO phis.billing_number_series (id, site_id, key, label, template, reset, kinds) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [series.id, series.siteId, series.key, series.label, series.template, series.reset, phisBillingKindsToBits(series.kinds)]);
  await writePhisBillingSeriesSources(db, series.id, series.sources);
}

export async function writePhisBillingSeriesSources(db: Db, seriesId: string, sources: readonly string[]) {
  await db.query("DELETE FROM phis.billing_series_sources WHERE series_id = $1", [seriesId]);
  if (sources.length) {
    await db.query("INSERT INTO phis.billing_series_sources (series_id, addon_id) SELECT $1, unnest($2::text[])", [seriesId, [...new Set(sources)]]);
  }
}

export async function updatePhisBillingSeries(db: Db, id: string, input: { label: string; kinds: readonly PhisBillingNumberedDocumentKind[] }) {
  await db.query("UPDATE phis.billing_number_series SET label = $2, kinds = $3 WHERE id = $1", [id, input.label, phisBillingKindsToBits(input.kinds)]);
}

export async function closePhisBillingSeries(db: Db, id: string) {
  await db.query("UPDATE phis.billing_number_series SET flags = flags | 1, closed_at = NOW() WHERE id = $1 AND (flags & 1) = 0", [id]);
}

/**
 * The next serial of a series in one counter period, taken: the row is created at 1 where it is new, then
 * advanced under its row lock in the caller's transaction, which a rollback undoes -- no gap, no sequence.
 * Marks the series `Used`.
 */
export async function takePhisBillingSerial(db: Db, seriesId: string, periodYear: number): Promise<bigint> {
  await db.query(`INSERT INTO phis.billing_number_counters (series_id, period_year) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [seriesId, periodYear]);
  const { rows } = await db.query<{ taken: string }>(`UPDATE phis.billing_number_counters SET next_value = next_value + 1
    WHERE series_id = $1 AND period_year = $2 RETURNING (next_value - 1)::text AS taken`, [seriesId, periodYear]);
  await db.query("UPDATE phis.billing_number_series SET flags = flags | 2 WHERE id = $1", [seriesId]);
  return BigInt(rows[0]!.taken);
}

/** The serial the next issue would take, read and not reserved. */
export async function peekPhisBillingSerial(db: Db, seriesId: string, periodYear: number): Promise<bigint> {
  const { rows } = await db.query<{ next_value: string }>("SELECT next_value::text FROM phis.billing_number_counters WHERE series_id = $1 AND period_year = $2",
    [seriesId, periodYear]);
  return BigInt(rows[0]?.next_value ?? "1");
}

// ---- documents ----

export type PhisStoredBillingDocument = {
  record: PhisBillingDocument;
  siteId: number;
  subjectId: number | null;
  providerReference: string | null;
  seriesId: string | null;
  seriesYear: number | null;
  storageKey: string | null;
  idempotencyKey: string | null;
  request: Record<string, unknown> | null;
  voidReason: string | null;
};

type DocumentRow = {
  id: string; site_id: number; kind: PhisBillingDocumentKind; number: string | null; label: string; issuer_kind: "merchant" | "provider"; issuer_name: string;
  issuer_tax_id: string | null; source_kind: "provider" | "addon"; source_addon_id: string; consumer_addon_id: string; reference: string;
  subject_id: number | null; subject: string | null; payment_id: string | null; refund_id: string | null; subscription_id: string | null; period_index: number | null;
  corrects_id: string | null; provider_reference: string | null; series_id: string | null; series_year: number | null; issued_at: Date; currency: string;
  total_minor: string; presentment_currency: string | null; presentment_minor: string | null; status: PhisBillingDocument["status"];
  content: PhisBillingDocumentContent | null; payment_state: PhisBillingDocument["paymentState"]; content_type: "application/pdf" | "text/html" | null;
  byte_size: string | null; sha256: string | null; storage_key: string | null; idempotency_key: string | null; request: Record<string, unknown> | null;
  void_reason: string | null; retain_until: Date; flags: number; created_at: Date; version: number;
};

const DOCUMENT_COLUMNS = `d.id::text, d.site_id, d.kind, d.number, d.label, d.issuer_kind, d.issuer_name, d.issuer_tax_id, d.source_kind, d.source_addon_id,
  d.consumer_addon_id, d.reference, d.subject_id, es.reference AS subject, d.payment_id::text, d.refund_id::text, d.subscription_id::text, d.period_index,
  d.corrects_id::text, d.provider_reference, d.series_id::text, d.series_year, d.issued_at, d.currency, d.total_minor::text, d.presentment_currency,
  d.presentment_minor::text, d.status, d.content, d.payment_state, d.content_type, d.byte_size::text, d.sha256, d.storage_key, d.idempotency_key, d.request,
  d.void_reason, d.retain_until, d.flags, d.created_at, d.version`;
const DOCUMENT_FROM = "phis.billing_documents d LEFT JOIN phis.entitlement_subjects es ON es.id = d.subject_id";

function documentFromRow(row: DocumentRow): PhisStoredBillingDocument {
  return {
    siteId: row.site_id, subjectId: row.subject_id, providerReference: row.provider_reference, seriesId: row.series_id, seriesYear: row.series_year,
    storageKey: row.storage_key, idempotencyKey: row.idempotency_key, request: row.request, voidReason: row.void_reason,
    record: {
      id: row.id, kind: row.kind, number: row.number, label: row.label,
      issuer: { kind: row.issuer_kind, name: row.issuer_name, taxId: row.issuer_tax_id },
      source: { kind: row.source_kind, addonId: row.source_addon_id },
      issuedAt: row.issued_at.toISOString(),
      total: { currency: row.currency, minor: row.total_minor },
      presentment: row.presentment_currency && row.presentment_minor !== null ? { currency: row.presentment_currency, minor: row.presentment_minor } : null,
      status: row.status,
      file: row.content_type && row.byte_size !== null && row.sha256 ? { contentType: row.content_type, byteSize: Number(row.byte_size), sha256: row.sha256 } : null,
      content: row.content, paymentState: row.payment_state, subject: row.subject,
      consumerAddonId: row.consumer_addon_id, reference: row.reference,
      payment: row.payment_id ? { paymentId: row.payment_id, refundId: row.refund_id } : null,
      subscription: row.subscription_id ? { subscriptionId: row.subscription_id, periodIndex: row.period_index } : null,
      correctsId: row.corrects_id, retainUntil: row.retain_until.toISOString(), flags: row.flags, createdAt: row.created_at.toISOString(), version: row.version,
    },
  };
}

export async function insertPhisBillingDocument(db: Db, document: PhisStoredBillingDocument) {
  const r = document.record;
  await db.query(`INSERT INTO phis.billing_documents (id, site_id, kind, number, label, issuer_kind, issuer_name, issuer_tax_id, source_kind, source_addon_id,
      consumer_addon_id, reference, subject_id, payment_id, refund_id, subscription_id, period_index, corrects_id, provider_reference, series_id, series_year,
      issued_at, currency, total_minor, presentment_currency, presentment_minor, status, content, payment_state, idempotency_key, request, retain_until, flags)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::bigint, $25, $26::bigint, $27,
      $28::jsonb, $29::jsonb, $30, $31::jsonb, $32, $33)`,
  [r.id, document.siteId, r.kind, r.number, r.label, r.issuer.kind, r.issuer.name, r.issuer.taxId, r.source.kind, r.source.addonId,
    r.consumerAddonId, r.reference, document.subjectId, r.payment?.paymentId ?? null, r.payment?.refundId ?? null, r.subscription?.subscriptionId ?? null,
    r.subscription?.periodIndex ?? null, r.correctsId, document.providerReference, document.seriesId, document.seriesYear, r.issuedAt, r.total.currency, r.total.minor,
    r.presentment?.currency ?? null, r.presentment?.minor ?? null, r.status, r.content === null ? null : JSON.stringify(r.content),
    r.paymentState === null ? null : JSON.stringify(r.paymentState), document.idempotencyKey, document.request === null ? null : JSON.stringify(document.request),
    r.retainUntil, r.flags]);
}

/** Writes what may move of a document: its file, status, payment state, flags, subject (on detach) and version. */
export async function writePhisBillingDocument(db: Db, document: PhisStoredBillingDocument) {
  const r = document.record;
  await db.query(`UPDATE phis.billing_documents SET status = $2, payment_state = $3::jsonb, flags = $4, subject_id = $5, content_type = $6, byte_size = $7,
      sha256 = $8, storage_key = $9, void_reason = $10, version = $11, updated_at = NOW() WHERE id = $1`,
  [r.id, r.status, r.paymentState === null ? null : JSON.stringify(r.paymentState), r.flags, document.subjectId, r.file?.contentType ?? null,
    r.file?.byteSize ?? null, r.file?.sha256 ?? null, document.storageKey, document.voidReason, r.version]);
}

export async function readPhisBillingDocument(db: Db, siteId: number, id: string, lock = false): Promise<PhisStoredBillingDocument | null> {
  if (!/^[0-9a-f-]{36}$/u.test(id)) return null;
  const { rows } = await db.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM} WHERE d.site_id = $1 AND d.id = $2::uuid ${lock ? "FOR UPDATE OF d" : ""}`, [siteId, id]);
  return rows[0] ? documentFromRow(rows[0]) : null;
}

export async function findPhisBillingDocumentByIdempotency(db: Db, siteId: number, sourceAddonId: string, key: string): Promise<PhisStoredBillingDocument | null> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["billing-issue", siteId, sourceAddonId, key])]);
  const { rows } = await db.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM}
    WHERE d.site_id = $1 AND d.source_addon_id = $2 AND d.idempotency_key = $3`, [siteId, sourceAddonId, key]);
  return rows[0] ? documentFromRow(rows[0]) : null;
}

export async function findPhisProviderBillingDocument(db: Db, siteId: number, sourceAddonId: string, providerReference: string, lock = false): Promise<PhisStoredBillingDocument | null> {
  const { rows } = await db.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM}
    WHERE d.site_id = $1 AND d.source_addon_id = $2 AND d.provider_reference = $3 ${lock ? "FOR UPDATE OF d" : ""}`, [siteId, sourceAddonId, providerReference]);
  return rows[0] ? documentFromRow(rows[0]) : null;
}

/** What credit notes that are not voided already took back of an invoice, in minor units. */
export async function sumPhisBillingCredits(db: Db, invoiceId: string): Promise<bigint> {
  const { rows } = await db.query<{ total: string | null }>(`SELECT SUM(total_minor)::text AS total FROM phis.billing_documents
    WHERE corrects_id = $1 AND kind = 'credit-note' AND status <> 'voided'`, [invoiceId]);
  return BigInt(rows[0]?.total ?? "0");
}

export type PhisBillingDocumentFilter = {
  siteId: number;
  /** Only this person's, and never a detached one. */
  subjectId?: number | null;
  /** Only what this Add-on issued or sold (`billing:v1` machine reads). */
  addonId?: string | null;
  references?: readonly string[] | null;
  /** With `references`: only the sales of this consumer. */
  consumerAddonId?: string | null;
  sourceAddonId?: string | null;
  issuerKind?: "merchant" | "provider" | null;
  issuerName?: string | null;
  paymentId?: string | null;
  subscriptionId?: string | null;
  periodIndex?: number | null;
  kinds?: readonly PhisBillingDocumentKind[] | null;
  statuses?: readonly PhisBillingDocument["status"][] | null;
  paymentState?: PhisBillingPaymentState | null;
  issuedFrom?: string | null;
  issuedTo?: string | null;
  /** Number, reference or label, case-insensitively. */
  search?: string | null;
};

/** Newest first, `limit` at a time from `cursor`; the cursor is the last row's `issued_at` and id. */
export async function listPhisBillingDocuments(db: Db, filter: PhisBillingDocumentFilter, page: { cursor: { issuedAt: string; id: string } | null; limit: number }) {
  const { rows } = await db.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM}
    WHERE d.site_id = $1
      AND ($2::int IS NULL OR (d.subject_id = $2 AND (d.flags & 4) = 0))
      AND ($3::text IS NULL OR d.source_addon_id = $3 OR d.consumer_addon_id = $3)
      AND ($4::text[] IS NULL OR d.reference = ANY($4::text[]))
      AND ($5::text IS NULL OR d.consumer_addon_id = $5)
      AND ($6::text IS NULL OR d.source_addon_id = $6)
      AND ($7::text IS NULL OR d.issuer_kind = $7)
      AND ($8::text IS NULL OR d.issuer_name ILIKE '%' || $8 || '%')
      AND ($9::uuid IS NULL OR d.payment_id = $9)
      AND ($10::uuid IS NULL OR d.subscription_id = $10)
      AND ($11::int IS NULL OR d.period_index = $11)
      AND ($12::text[] IS NULL OR d.kind = ANY($12::text[]))
      AND ($13::text[] IS NULL OR d.status = ANY($13::text[]))
      AND ($14::text IS NULL OR d.payment_state->>'state' = $14)
      AND ($15::timestamptz IS NULL OR d.issued_at >= $15)
      AND ($16::timestamptz IS NULL OR d.issued_at < $16)
      AND ($17::text IS NULL OR d.number ILIKE '%' || $17 || '%' OR d.reference ILIKE '%' || $17 || '%' OR d.label ILIKE '%' || $17 || '%')
      AND ($18::timestamptz IS NULL OR (d.issued_at, d.id) < ($18::timestamptz, $19::uuid))
    ORDER BY d.issued_at DESC, d.id DESC
    LIMIT $20`,
  [filter.siteId, filter.subjectId ?? null, filter.addonId ?? null, filter.references ?? null, filter.consumerAddonId ?? null, filter.sourceAddonId ?? null,
    filter.issuerKind ?? null, filter.issuerName ?? null, filter.paymentId ?? null, filter.subscriptionId ?? null, filter.periodIndex ?? null,
    filter.kinds ?? null, filter.statuses ?? null, filter.paymentState ?? null, filter.issuedFrom ?? null, filter.issuedTo ?? null, filter.search ?? null,
    page.cursor?.issuedAt ?? null, page.cursor?.id ?? null, page.limit + 1]);
  const documents = rows.slice(0, page.limit).map(documentFromRow);
  const last = documents.at(-1);
  return { documents, next: rows.length > page.limit && last ? { issuedAt: last.record.issuedAt, id: last.record.id } : null };
}

/** The credit notes and reminders that refer to a document, oldest first. */
export async function listPhisBillingCorrections(db: Db, siteId: number, documentId: string): Promise<PhisStoredBillingDocument[]> {
  const { rows } = await db.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM}
    WHERE d.site_id = $1 AND d.corrects_id = $2::uuid ORDER BY d.issued_at, d.id LIMIT 200`, [siteId, documentId]);
  return rows.map(documentFromRow);
}

/** Issued documents still waiting for their file since before `before`: what the job voids. */
export async function listStalePendingPhisBillingDocuments(db: Db, before: Date, limit: number): Promise<{ siteId: number; id: string }[]> {
  const { rows } = await db.query<{ site_id: number; id: string }>(`SELECT site_id, id::text FROM phis.billing_documents
    WHERE status = 'pending' AND source_kind = 'addon' AND created_at < $1 ORDER BY created_at LIMIT $2`, [before, limit]);
  return rows.map(row => ({ siteId: row.site_id, id: row.id }));
}

/** Documents whose retention has ended: what the job removes, file first. */
export async function listExpiredPhisBillingDocuments(db: Db, now: Date, limit: number): Promise<{ siteId: number; id: string; storageKey: string | null; byteSize: number | null }[]> {
  const { rows } = await db.query<{ site_id: number; id: string; storage_key: string | null; byte_size: string | null }>(`SELECT site_id, id::text, storage_key, byte_size::text
    FROM phis.billing_documents d WHERE retain_until <= $1
      AND NOT EXISTS (SELECT 1 FROM phis.billing_documents c WHERE c.corrects_id = d.id AND c.retain_until > $1)
    ORDER BY retain_until LIMIT $2`, [now, limit]);
  return rows.map(row => ({ siteId: row.site_id, id: row.id, storageKey: row.storage_key, byteSize: row.byte_size === null ? null : Number(row.byte_size) }));
}

export async function deletePhisBillingDocument(db: Db, id: string) {
  await db.query("DELETE FROM phis.billing_documents WHERE id = $1", [id]);
}

/**
 * Detaches a person's documents on a Site (`Detached`, subject gone): what their deletion request does
 * within the retention. Answers the documents that changed, for their event.
 */
export async function detachPhisBillingDocumentsOfSubject(db: Db, siteId: number, subjectId: number): Promise<PhisStoredBillingDocument[]> {
  const { rows } = await db.query<{ id: string }>(`UPDATE phis.billing_documents SET subject_id = NULL, flags = flags | 4, version = version + 1, updated_at = NOW()
    WHERE site_id = $1 AND subject_id = $2 RETURNING id::text`, [siteId, subjectId]);
  const changed: PhisStoredBillingDocument[] = [];
  for (const row of rows) changed.push((await readPhisBillingDocument(db, siteId, row.id))!);
  return changed;
}

/** The person behind an entitlement subject of a Site, for the subject a document names. */
export async function findPhisBillingSubjectId(db: Db, siteId: number, subject: string): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>("SELECT id FROM phis.entitlement_subjects WHERE site_id = $1 AND reference = $2", [siteId, subject]);
  return rows[0]?.id ?? null;
}

/** A person's subject on a Site, where they have one; `null` where they never had a document to own. */
export async function findPhisBillingSubjectOfUser(db: Db, siteId: number, userId: number): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>("SELECT id FROM phis.entitlement_subjects WHERE site_id = $1 AND user_id = $2", [siteId, userId]);
  return rows[0]?.id ?? null;
}

/**
 * Owes `billing-document.changed` to its source Add-on and, where different, its consumer Add-on, among
 * `listeners` (the enabled Add-ons that declare the handler) configured on the Site. No state travels.
 */
export async function enqueuePhisBillingDocumentChanged(db: Db, document: PhisStoredBillingDocument, listeners: readonly string[]) {
  const recipients = [...new Set([document.record.source.addonId, document.record.consumerAddonId])].filter(addonId => listeners.includes(addonId));
  if (recipients.length === 0) return;
  await db.query(`INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, subject_kind, payload)
    SELECT $1::smallint, installed.addon_id, 'billing-document.changed', 'billing-document', $3::jsonb
    FROM phis.site_server_addons installed
    WHERE installed.site_id = $1 AND installed.addon_id = ANY($2::text[]) AND installed.configuration_status = 'ready'
    ORDER BY installed.addon_id`,
  [document.siteId, recipients, JSON.stringify({ documentId: document.record.id, reference: document.record.reference, version: document.record.version })]);
}

// ---- Core's private billing store ----

export type PhisBillingStorageUsage = { bytes: number; objects: number; quotaBytes: number | null; quotaObjects: number | null };

export async function readPhisBillingStorage(db: Db, siteId: number): Promise<PhisBillingStorageUsage> {
  const { rows } = await db.query<{ bytes: string; objects: number; quota_bytes: string | null; quota_objects: number | null }>(
    "SELECT bytes::text, objects, quota_bytes::text, quota_objects FROM phis.billing_storage WHERE site_id = $1", [siteId]);
  const row = rows[0];
  return { bytes: Number(row?.bytes ?? 0), objects: row?.objects ?? 0, quotaBytes: row?.quota_bytes == null ? null : Number(row.quota_bytes), quotaObjects: row?.quota_objects ?? null };
}

/** Books (or, negative, gives back) bytes and objects; `over-quota` where a positive booking would pass the ceiling. */
export async function bookPhisBillingStorage(db: Db, siteId: number, bytes: number, objects: number): Promise<"booked" | "over-quota"> {
  await db.query("INSERT INTO phis.billing_storage (site_id) VALUES ($1) ON CONFLICT DO NOTHING", [siteId]);
  const { rowCount } = await db.query(`UPDATE phis.billing_storage SET bytes = GREATEST(bytes + $2::bigint, 0), objects = GREATEST(objects + $3, 0)
    WHERE site_id = $1 AND ($2::bigint <= 0 OR quota_bytes IS NULL OR bytes + $2::bigint <= quota_bytes)
      AND ($3 <= 0 OR quota_objects IS NULL OR objects + $3 <= quota_objects)`, [siteId, bytes, objects]);
  return (rowCount ?? 0) > 0 ? "booked" : "over-quota";
}

/** The store's own ceiling; `undefined` leaves one as it is, `null` lifts it. */
export async function setPhisBillingStorageQuota(db: Db, siteId: number, quota: { bytes?: number | null; objects?: number | null }) {
  await db.query("INSERT INTO phis.billing_storage (site_id) VALUES ($1) ON CONFLICT DO NOTHING", [siteId]);
  await db.query(`UPDATE phis.billing_storage SET quota_bytes = CASE WHEN $2::boolean THEN $3::bigint ELSE quota_bytes END,
      quota_objects = CASE WHEN $4::boolean THEN $5::int ELSE quota_objects END WHERE site_id = $1`,
  [siteId, quota.bytes !== undefined, quota.bytes ?? null, quota.objects !== undefined, quota.objects ?? null]);
}

/** The requester of a support ticket and whether it is still open (before Resolved): what the Supporter's document list asks. */
export async function readPhisBillingTicketRequester(db: Db, siteId: number, ticketId: number): Promise<{ requesterUserId: number | null; open: boolean } | null> {
  const { rows } = await db.query<{ requester_user_id: number | null; status: number }>(
    "SELECT requester_user_id, status FROM phis.support_tickets WHERE site_id = $1 AND id = $2", [siteId, ticketId]);
  return rows[0] ? { requesterUserId: rows[0].requester_user_id, open: rows[0].status < PhisSupportTicketStatus.Resolved } : null;
}

/** Whether a payment or subscription of the Site belongs to this Add-on's sales: what an issued document may link to. */
export async function isPhisBillingSaleLinkOf(db: Db, siteId: number, consumerAddonId: string, link: { paymentId?: string; subscriptionId?: string }): Promise<boolean> {
  const { rowCount } = link.paymentId !== undefined
    ? await db.query("SELECT 1 FROM phis.payments WHERE site_id = $1 AND id::text = $2 AND consumer_addon_id = $3", [siteId, link.paymentId, consumerAddonId])
    : await db.query("SELECT 1 FROM phis.payment_subscriptions WHERE site_id = $1 AND id::text = $2 AND consumer_addon_id = $3", [siteId, link.subscriptionId, consumerAddonId]);
  return (rowCount ?? 0) > 0;
}

/** A payment's Provider documents still `pending` for its capture (`refundId` null) or one refund, locked. */
export async function listPendingPhisProviderBillingDocumentIds(db: Db, siteId: number, paymentId: string, refundId: string | null): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`SELECT id::text FROM phis.billing_documents WHERE site_id = $1 AND payment_id::text = $2
    AND refund_id IS NOT DISTINCT FROM $3::uuid AND source_kind = 'provider' AND status = 'pending' FOR UPDATE`, [siteId, paymentId, refundId]);
  return rows.map(row => row.id);
}
