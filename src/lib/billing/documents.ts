import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  PhisBillingDocumentFlag, type PhisBillingDocument, type PhisBillingDocumentIssueInput, type PhisBillingDocumentKind,
  type PhisBillingNumberSeries, type PhisBillingNumberedDocumentKind, type PhisBillingPaymentState,
} from "@phis/contracts/billing";
import { PhisPaymentDocumentFeatureFlag, type PhisPaymentProviderDocument } from "@phis/contracts/payments";
import type { PoolClient } from "pg";

import {
  enqueuePhisBillingDocumentChanged, findPhisBillingDocumentByIdempotency, findPhisBillingSubjectId, findPhisBillingSubjectOfUser, findPhisProviderBillingDocument,
  isPhisBillingSaleLinkOf, listPendingPhisProviderBillingDocumentIds,
  insertPhisBillingDocument, listExpiredPhisBillingDocuments, listPhisBillingDocuments, listStalePendingPhisBillingDocuments,
  deletePhisBillingDocument, detachPhisBillingDocumentsOfSubject, readOpenPhisBillingSeriesByKey, readPhisBillingDocument, readPhisBillingSourceKinds,
  sumPhisBillingCredits, takePhisBillingSerial, writePhisBillingDocument, type PhisBillingDocumentFilter, type PhisStoredBillingDocument,
  type PhisStoredBillingSeries,
} from "@/db/billing.mts";
import { listPhisPaymentRefunds } from "@/db/payments.mts";
import { retryPhisPaymentRecordTasks } from "@/db/payment-records.mts";
import { readPhisPaymentSubscription } from "@/db/payment-subscriptions.mts";
import { getSiteByKey, getSiteIdentityById } from "@/db/sites";
import { getPool } from "@/lib/db";
import { withPoolTransaction } from "@/lib/db-transaction";
import { getPhisConfigSync } from "@/lib/config";
import type { PhisPaymentRecordCollector } from "@/lib/payments/records";
import { PhisPaymentError } from "@/lib/payments/validation";
import {
  parsePhisBillingTemplate, phisBillingCalendarOf, phisBillingCounterYear, renderPhisBillingNumber,
} from "./number-template.ts";
import { deletePhisBillingFile, phisBillingStorageKey, putPhisBillingFile } from "./store.ts";
import {
  closePhisBillingSeriesOf, createPhisBillingSeriesOf, editPhisBillingSeriesOf, listPhisBillingSeriesOf, previewPhisBillingSeriesOf,
} from "./series.ts";
import {
  PHIS_BILLING_KINDS, PHIS_BILLING_NUMBERED_KINDS, PHIS_BILLING_PAYMENT_STATES, PhisBillingError, phisBillingRetainUntil, readPhisBillingContent,
  readPhisBillingInstant, readPhisBillingIssuer, readPhisBillingMinor, readPhisBillingMoney, readPhisBillingText,
} from "./validation.ts";

/**
 * Core's billing documents (`billing:v1`; PAYMENTS.md, billing documents): issuing, the file, voiding,
 * payment state, reading by the access rules, opening by a short-lived signed address, the number series,
 * and the archive of the Provider's documents. Every write is one transaction and owes
 * `billing-document.changed` in it.
 */

type Db = Pick<PoolClient, "query">;

/** Who asks: an Add-on through `billing:v1`, or Core's own route for a person; and the person acting, if any. */
export type PhisBillingActor = {
  siteId: number;
  addonId: string | null;
  actorUserId: number | null;
  /** The acting user holds the Site role Admin or Accountant (`PHI_ACCESS_BILLING`). */
  billingStaff: () => Promise<boolean>;
  /** The listeners of `billing-document.changed`: the enabled Add-ons that declare its handler. */
  listeners: () => readonly string[];
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_REFERENCES = 100;

async function siteTimeZone(siteId: number) {
  return (await getSiteIdentityById(siteId))?.timeZone ?? "UTC";
}

// ---- reading ----

/** The subject behind the acting person, read without creating one: a person without one has no documents. */
async function actingSubjectId(db: Db, actor: PhisBillingActor): Promise<number | null> {
  return actor.actorUserId === null ? null : findPhisBillingSubjectOfUser(db, actor.siteId, actor.actorUserId);
}

/** Whether the actor may read this document: its issuer or seller, its person (not detached), Admin or Accountant. */
async function mayRead(actor: PhisBillingActor, document: PhisStoredBillingDocument) {
  if (actor.addonId && (document.record.source.addonId === actor.addonId || document.record.consumerAddonId === actor.addonId)) return true;
  return mayOpen(actor, document);
}

/** Whether the acting person may open this document's file: its owner (not detached), Admin or Accountant. */
async function mayOpen(actor: PhisBillingActor, document: PhisStoredBillingDocument) {
  if (actor.actorUserId === null) return false;
  const own = document.subjectId !== null && (document.record.flags & PhisBillingDocumentFlag.Detached) === 0
    && document.subjectId === await actingSubjectId(getPool(), actor);
  return own || actor.billingStaff();
}

function encodeCursor(cursor: { issuedAt: string; id: string } | null) {
  return cursor ? Buffer.from(`${cursor.issuedAt}|${cursor.id}`).toString("base64url") : null;
}

function decodeCursor(value: unknown): { issuedAt: string; id: string } | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 200) throw new PhisBillingError("invalid_input", "cursor is the one a listing answered.");
  const [issuedAt, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (!issuedAt || !id || !Number.isFinite(Date.parse(issuedAt)) || !/^[0-9a-f-]{36}$/u.test(id)) throw new PhisBillingError("invalid_input", "cursor is the one a listing answered.");
  return { issuedAt, id };
}

function readLimit(value: unknown) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_LIMIT) throw new PhisBillingError("invalid_input", `limit is 1 to ${MAX_LIMIT}.`);
  return value as number;
}

function readKinds(value: unknown): PhisBillingDocumentKind[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some(kind => !PHIS_BILLING_KINDS.includes(kind))) throw new PhisBillingError("invalid_input", `kinds is a list of ${PHIS_BILLING_KINDS.join(", ")}.`);
  return [...new Set(value as PhisBillingDocumentKind[])];
}

/**
 * `billing:v1` `list`: by `subject` only for the acting person who is that subject or Admin or Accountant;
 * otherwise what this Add-on issued or sold. Every other filter narrows.
 */
export async function listPhisBillingDocumentsFor(actor: PhisBillingActor, input: Parameters<import("@phis/contracts/billing").PhisBillingCapabilityV1["list"]>[0]) {
  const filter: PhisBillingDocumentFilter = { siteId: actor.siteId };
  if (input?.subject !== undefined) {
    if (typeof input.subject !== "string") throw new PhisBillingError("invalid_input", "subject is an entitlement subject.");
    const subjectId = await findPhisBillingSubjectId(getPool(), actor.siteId, input.subject);
    const own = subjectId !== null && subjectId === await actingSubjectId(getPool(), actor);
    if (!own && !await actor.billingStaff()) throw new PhisBillingError("forbidden", "Another person's documents are read only by that person, or by Admin or Accountant.");
    if (subjectId === null) return { documents: [], cursor: null };
    filter.subjectId = subjectId;
  } else {
    filter.addonId = actor.addonId;
  }
  if (input?.references !== undefined) {
    if (!Array.isArray(input.references) || input.references.length > MAX_REFERENCES || input.references.some(entry => typeof entry !== "string")) {
      throw new PhisBillingError("invalid_input", `references is a list of at most ${MAX_REFERENCES} references.`);
    }
    if (input.references.length === 0) return { documents: [], cursor: null };
    filter.references = input.references;
    // The references are this Add-on's own sales'.
    filter.consumerAddonId = actor.addonId;
  }
  if (input?.paymentId !== undefined) filter.paymentId = /^[0-9a-f-]{36}$/u.test(String(input.paymentId)) ? input.paymentId : "00000000-0000-0000-0000-000000000000";
  if (input?.subscriptionId !== undefined) filter.subscriptionId = /^[0-9a-f-]{36}$/u.test(String(input.subscriptionId)) ? input.subscriptionId : "00000000-0000-0000-0000-000000000000";
  if (input?.periodIndex !== undefined) {
    if (!Number.isInteger(input.periodIndex) || input.periodIndex < 0) throw new PhisBillingError("invalid_input", "periodIndex is a period's index.");
    filter.periodIndex = input.periodIndex;
  }
  filter.kinds = readKinds(input?.kinds);
  const page = await listPhisBillingDocuments(getPool(), filter, { cursor: decodeCursor(input?.cursor), limit: readLimit(input?.limit) });
  return { documents: page.documents.map(document => document.record), cursor: encodeCursor(page.next) };
}

export async function getPhisBillingDocumentFor(actor: PhisBillingActor, documentId: unknown): Promise<PhisBillingDocument | null> {
  if (typeof documentId !== "string") return null;
  const document = await readPhisBillingDocument(getPool(), actor.siteId, documentId);
  return document && await mayRead(actor, document) ? document.record : null;
}

// ---- opening: a short-lived signed address ----

const OPEN_DEFAULT_TTL = 300;
const OPEN_MAX_TTL = 900;

function openKey() {
  const secret = getPhisConfigSync().auth?.transactionEncryptionKey?.trim() ?? "";
  if (!secret) throw new PhisBillingError("unavailable", "Missing auth.transactionEncryptionKey in runtime config; a document address cannot be signed without it.");
  return secret;
}

function signOpen(siteId: number, documentId: string, disposition: string, expires: number) {
  return createHmac("sha256", openKey()).update(`billing-document-open:${siteId}:${documentId}:${disposition}:${expires}`).digest("base64url");
}

/**
 * The address a document's file (or, without one, Core's view of its content) is served from, signed for
 * one document, one disposition and `ttlSeconds`. Needs an acting person who may open it; refused for a
 * document that is not `available`.
 */
export async function openPhisBillingDocument(actor: PhisBillingActor, input: { documentId: unknown; disposition: unknown; ttlSeconds?: unknown }) {
  if (input.disposition !== "inline" && input.disposition !== "attachment") throw new PhisBillingError("invalid_input", "disposition is inline or attachment.");
  const ttl = input.ttlSeconds === undefined ? OPEN_DEFAULT_TTL : input.ttlSeconds;
  if (!Number.isInteger(ttl) || (ttl as number) < 1 || (ttl as number) > OPEN_MAX_TTL) throw new PhisBillingError("invalid_input", `ttlSeconds is 1 to ${OPEN_MAX_TTL}.`);
  const document = typeof input.documentId === "string" ? await readPhisBillingDocument(getPool(), actor.siteId, input.documentId) : null;
  if (!document || !await mayOpen(actor, document)) throw new PhisBillingError("not_found", "No such document to open.");
  if (document.record.status !== "available") throw new PhisBillingError("invalid_state", "The document is not available.");
  const site = await getSiteIdentityById(actor.siteId);
  const full = site ? await getSiteByKey(site.key) : null;
  if (!full) throw new PhisBillingError("not_found", "No such Site.");
  const expires = Math.floor(Date.now() / 1000) + (ttl as number);
  const url = new URL(`/api/site/billing-documents/${document.record.id}/file`, full.publicBaseUrl);
  url.searchParams.set("d", input.disposition);
  url.searchParams.set("e", String(expires));
  url.searchParams.set("s", signOpen(actor.siteId, document.record.id, input.disposition, expires));
  return { url: url.href, expiresAt: new Date(expires * 1000).toISOString() };
}

/** Whether a signed address is one `openPhisBillingDocument` gave and still valid. */
export function verifyPhisBillingOpen(siteId: number, documentId: string, params: { d: string | null; e: string | null; s: string | null }): "inline" | "attachment" | null {
  if ((params.d !== "inline" && params.d !== "attachment") || !params.e || !/^[0-9]{1,12}$/.test(params.e) || !params.s) return null;
  const expires = Number(params.e);
  if (expires * 1000 < Date.now() || expires * 1000 > Date.now() + (OPEN_MAX_TTL + 60) * 1000) return null;
  const expected = Buffer.from(signOpen(siteId, documentId, params.d, expires));
  const given = Buffer.from(params.s);
  return expected.length === given.length && timingSafeEqual(expected, given) ? params.d : null;
}

// ---- issuing ----

function requireIssuer(actor: PhisBillingActor): string {
  if (!actor.addonId) throw new PhisBillingError("forbidden", "Only an Add-on issues documents.");
  return actor.addonId;
}

async function owe(db: Db, actor: PhisBillingActor, document: PhisStoredBillingDocument) {
  await enqueuePhisBillingDocumentChanged(db, document, actor.listeners());
}

/**
 * `billing:v1` `issue`. `issuedFor` is the Add-on whose sale it documents, which the caller has checked
 * names the issuer in its manifest's `billing.issuedBy`; `declaredKinds` what the issuer's manifest states
 * it issues.
 */
export async function issuePhisBillingDocument(actor: PhisBillingActor, input: PhisBillingDocumentIssueInput, rules: {
  declaredKinds: readonly PhisBillingDocumentKind[];
  mayIssueFor: (consumerAddonId: string) => boolean;
}): Promise<PhisBillingDocument> {
  const issuer = requireIssuer(actor);
  if (!input || typeof input !== "object") throw new PhisBillingError("invalid_input", "issue takes a document.");
  if (!PHIS_BILLING_KINDS.includes(input.kind)) throw new PhisBillingError("invalid_input", `kind is one of ${PHIS_BILLING_KINDS.join(", ")}.`);
  const numbered = PHIS_BILLING_NUMBERED_KINDS.includes(input.kind);
  if (!rules.declaredKinds.includes(input.kind)) throw new PhisBillingError("forbidden", `The manifest of ${issuer} does not declare that it issues ${input.kind} (billing.issues).`);
  const allowed = await readPhisBillingSourceKinds(getPool(), actor.siteId, issuer);
  if (!allowed.includes(input.kind)) throw new PhisBillingError("forbidden", `${issuer} is not allowed to issue ${input.kind} on this Site (phis billing source allow).`);
  if (numbered ? typeof input.series !== "string" || input.number !== undefined : input.series !== undefined) {
    throw new PhisBillingError("invalid_input", numbered ? "An invoice, credit note or reminder names its series and no number of its own." : "A receipt or confirmation names no series.");
  }
  const ownNumber = input.number === undefined ? null : readPhisBillingText(input.number, "number", 40);
  const idempotencyKey = readPhisBillingText(input.idempotencyKey, "idempotencyKey", 255);
  const label = readPhisBillingText(input.label, "label");
  const reference = readPhisBillingText(input.reference, "reference", 255);
  const consumerAddonId = input.consumerAddonId ?? issuer;
  if (consumerAddonId !== issuer && !rules.mayIssueFor(consumerAddonId)) {
    throw new PhisBillingError("forbidden", `${consumerAddonId} does not name ${issuer} in its manifest's billing.issuedBy.`);
  }
  const issuedAt = input.issuedAt === undefined ? new Date().toISOString() : readPhisBillingInstant(input.issuedAt, "issuedAt");
  const merchant = readPhisBillingIssuer(input.issuer, "merchant");
  const content = readPhisBillingContent(input.content, input.kind);
  if (input.file !== "follows" && input.file !== "none") throw new PhisBillingError("invalid_input", "file is follows or none.");
  if (input.file === "none" && numbered) throw new PhisBillingError("invalid_input", "An invoice, credit note or reminder is issued with its file (file: follows).");
  const corrects = input.kind === "credit-note" || input.kind === "reminder";
  if (corrects !== (typeof input.correctsId === "string")) throw new PhisBillingError("invalid_input", corrects ? `A ${input.kind} names the invoice it refers to (correctsId).` : "Only a credit note or a reminder names a document it refers to.");
  const payment = input.payment == null ? null : { paymentId: readPhisBillingText(input.payment.paymentId, "payment.paymentId", 64), refundId: input.payment.refundId == null ? null : readPhisBillingText(input.payment.refundId, "payment.refundId", 64) };
  const subscription = input.subscription == null ? null : {
    subscriptionId: readPhisBillingText(input.subscription.subscriptionId, "subscription.subscriptionId", 64),
    periodIndex: input.subscription.periodIndex === null ? null : Number.isInteger(input.subscription.periodIndex) && input.subscription.periodIndex >= 0
      ? input.subscription.periodIndex : (() => { throw new PhisBillingError("invalid_input", "subscription.periodIndex is a period's index or null."); })(),
  };
  const request = { kind: input.kind, series: input.series ?? null, number: ownNumber, label, subject: input.subject ?? null, consumerAddonId, reference,
    issuedAt: input.issuedAt === undefined ? null : issuedAt, issuer: merchant, content, correctsId: input.correctsId ?? null, payment, subscription, file: input.file };
  const timeZone = await siteTimeZone(actor.siteId);

  const document = await withPoolTransaction(getPool(), async db => {
    const previous = await findPhisBillingDocumentByIdempotency(db, actor.siteId, issuer, idempotencyKey);
    if (previous) {
      if (!isDeepStrictEqual(previous.request, request)) throw new PhisBillingError("idempotency_conflict", "This idempotency key issued another document.");
      return previous;
    }
    const subjectId = input.subject == null ? null : await findPhisBillingSubjectId(db, actor.siteId, input.subject);
    if (input.subject != null && subjectId === null) throw new PhisBillingError("invalid_input", "subject is nobody on this Site.");
    if (payment && !await isPhisBillingSaleLinkOf(db, actor.siteId, consumerAddonId, { paymentId: payment.paymentId })) {
      throw new PhisBillingError("invalid_input", "payment is not a payment of this sale's Add-on.");
    }
    if (subscription && !await isPhisBillingSaleLinkOf(db, actor.siteId, consumerAddonId, { subscriptionId: subscription.subscriptionId })) {
      throw new PhisBillingError("invalid_input", "subscription is not a subscription of this sale's Add-on.");
    }
    let corrected: PhisStoredBillingDocument | null = null;
    if (corrects) {
      corrected = await readPhisBillingDocument(db, actor.siteId, input.correctsId!, true);
      if (!corrected || corrected.record.kind !== "invoice" || corrected.record.status === "voided" || corrected.record.consumerAddonId !== consumerAddonId) {
        throw new PhisBillingError("invalid_input", "correctsId is not an invoice of this sale's Add-on that was issued.");
      }
      if (corrected.record.total.currency !== content.currency) throw new PhisBillingError("invalid_input", "A credit note or reminder is in its invoice's currency.");
      if (input.kind === "credit-note") {
        const credited = await sumPhisBillingCredits(db, corrected.record.id);
        if (credited + BigInt(content.totals.total.minor) > BigInt(corrected.record.total.minor)) {
          throw new PhisBillingError("invalid_input", "The credit notes of an invoice never pass its total.");
        }
      }
    }
    const calendar = phisBillingCalendarOf(new Date(issuedAt), timeZone);
    let number = ownNumber;
    let series: PhisStoredBillingSeries | null = null;
    let seriesYear: number | null = null;
    if (numbered) {
      series = await readOpenPhisBillingSeriesByKey(db, actor.siteId, input.series!, true);
      if (!series || !series.sources.includes(issuer) || !series.kinds.includes(input.kind as PhisBillingNumberedDocumentKind)) {
        throw new PhisBillingError("forbidden", `There is no open series "${input.series}" that ${issuer} may number ${input.kind} from.`);
      }
      seriesYear = phisBillingCounterYear(series.reset, calendar);
      number = renderPhisBillingNumber(parsePhisBillingTemplate(series.template, series.reset), await takePhisBillingSerial(db, series.id, seriesYear), calendar);
    }
    const stored: PhisStoredBillingDocument = {
      siteId: actor.siteId, subjectId, providerReference: null, seriesId: series?.id ?? null, seriesYear, storageKey: null, idempotencyKey, request, voidReason: null,
      record: {
        id: randomUUID(), kind: input.kind, number, label, issuer: merchant, source: { kind: "addon", addonId: issuer }, issuedAt,
        total: { ...content.totals.total }, presentment: null, status: input.file === "none" ? "available" : "pending", file: null, content,
        paymentState: input.kind === "invoice" || input.kind === "reminder" ? { state: "open", paidMinor: "0", at: issuedAt } : null,
        subject: input.subject ?? null, consumerAddonId, reference, payment, subscription, correctsId: corrected?.record.id ?? null,
        retainUntil: phisBillingRetainUntil(calendar.year), flags: 0, createdAt: new Date().toISOString(), version: 1,
      },
    };
    try { await insertPhisBillingDocument(db, stored); }
    catch (error) {
      if ((error as { code?: string }).code === "23505") throw new PhisBillingError("invalid_input", "This number is already used by a document of the issuer.");
      throw error;
    }
    await owe(db, actor, stored);
    if (corrected && input.kind === "credit-note" && await sumPhisBillingCredits(db, corrected.record.id) === BigInt(corrected.record.total.minor)) {
      corrected.record.flags |= PhisBillingDocumentFlag.Credited; corrected.record.version += 1;
      await writePhisBillingDocument(db, corrected);
      await owe(db, actor, corrected);
    }
    return stored;
  });
  return document.record;
}

/** A document of this issuer's, under its row lock; `not_found` for anybody else's. */
async function issuedBy(db: Db, actor: PhisBillingActor, documentId: unknown) {
  const issuer = requireIssuer(actor);
  const document = typeof documentId === "string" ? await readPhisBillingDocument(db, actor.siteId, documentId, true) : null;
  if (!document || document.record.source.kind !== "addon" || document.record.source.addonId !== issuer) throw new PhisBillingError("not_found", "No such document of this issuer.");
  return document;
}

/** `billing:v1` `attachFile`: the PDF of a `pending` issued document, once; size and digest checked as it is stored. */
export async function attachPhisBillingFile(actor: PhisBillingActor, input: Parameters<import("@phis/contracts/billing").PhisBillingCapabilityV1["attachFile"]>[0]) {
  if (input?.contentType !== "application/pdf") throw new PhisBillingError("invalid_input", "An issued document's file is a PDF.");
  const before = await withPoolTransaction(getPool(), db => issuedBy(db, actor, input.documentId));
  if (before.record.status !== "pending" || before.storageKey) throw new PhisBillingError("invalid_state", "Only a pending document takes its file, once.");
  const site = await getSiteIdentityById(actor.siteId);
  if (!site) throw new PhisBillingError("not_found", "No such Site.");
  const storageKey = phisBillingStorageKey(site.key, new Date(before.record.issuedAt).getUTCFullYear(), before.record.id);
  let stored: { byteSize: number; sha256: string };
  try {
    stored = await putPhisBillingFile({ siteId: actor.siteId, siteKey: site.key, storageKey, contentType: "application/pdf", body: input.body,
      declared: { byteSize: input.byteSize, sha256: typeof input.sha256 === "string" ? input.sha256.toLowerCase() : "" } });
  } catch (error) {
    throw error instanceof PhisBillingError ? error : new PhisBillingError("invalid_input", error instanceof Error ? error.message : "The file could not be stored.");
  }
  const document = await withPoolTransaction(getPool(), async db => {
    const current = await issuedBy(db, actor, input.documentId);
    if (current.record.status !== "pending" || current.storageKey) throw new PhisBillingError("invalid_state", "Only a pending document takes its file, once.");
    current.storageKey = storageKey;
    current.record.file = { contentType: "application/pdf", byteSize: stored.byteSize, sha256: stored.sha256 };
    current.record.status = "available"; current.record.version += 1;
    await writePhisBillingDocument(db, current);
    await owe(db, actor, current);
    return current;
  });
  return document.record;
}

/** `billing:v1` `void`: an issued document still `pending` is withdrawn; its number stays used. */
export async function voidPhisBillingDocument(actor: PhisBillingActor, input: { documentId: unknown; reason: unknown }) {
  const reason = readPhisBillingText(input?.reason, "reason", 500);
  return (await withPoolTransaction(getPool(), async db => {
    const document = await issuedBy(db, actor, input.documentId);
    if (document.record.status === "voided") return document;
    if (document.record.status !== "pending") throw new PhisBillingError("invalid_state", "An available document is never withdrawn; a credit note corrects it.");
    voidDocument(document, reason);
    await writePhisBillingDocument(db, document);
    await owe(db, actor, document);
    return document;
  })).record;
}

function voidDocument(document: PhisStoredBillingDocument, reason: string) {
  document.record.status = "voided"; document.record.flags |= PhisBillingDocumentFlag.Voided; document.record.version += 1;
  document.voidReason = reason;
}

/** `billing:v1` `setPaymentState`: what is known of a merchant invoice's or reminder's payment, by its issuer. */
export async function setPhisBillingPaymentState(actor: PhisBillingActor, input: { documentId: unknown; state: unknown; paidMinor: unknown; at: unknown }) {
  if (!PHIS_BILLING_PAYMENT_STATES.includes(input?.state as PhisBillingPaymentState)) throw new PhisBillingError("invalid_input", `state is one of ${PHIS_BILLING_PAYMENT_STATES.join(", ")}.`);
  const paidMinor = readPhisBillingMinor(input.paidMinor, "paidMinor");
  const at = readPhisBillingInstant(input.at, "at");
  return (await withPoolTransaction(getPool(), async db => {
    const document = await issuedBy(db, actor, input.documentId);
    if (document.record.kind !== "invoice" && document.record.kind !== "reminder") throw new PhisBillingError("invalid_state", "Only an invoice or a reminder has a payment state.");
    if (document.record.status === "voided") throw new PhisBillingError("invalid_state", "A voided document has no payment state.");
    const state = { state: input.state as PhisBillingPaymentState, paidMinor, at };
    if (isDeepStrictEqual(document.record.paymentState, state)) return document;
    document.record.paymentState = state; document.record.version += 1;
    await writePhisBillingDocument(db, document);
    await owe(db, actor, document);
    return document;
  })).record;
}

// ---- number series: `series.ts`, bound to the pool and the Site's time zone here ----

export async function listPhisBillingSeriesRecords(siteId: number, filter: { open?: boolean; source?: string } = {}): Promise<PhisBillingNumberSeries[]> {
  return listPhisBillingSeriesOf(getPool(), siteId, await siteTimeZone(siteId), filter);
}

export async function previewPhisBillingSeries(siteId: number, input: { template: unknown; reset: unknown }): Promise<{ next: string }> {
  return previewPhisBillingSeriesOf(getPool(), siteId, await siteTimeZone(siteId), input);
}

export async function createPhisBillingSeries(siteId: number, input: Parameters<typeof createPhisBillingSeriesOf>[3], issuers: readonly string[]): Promise<PhisBillingNumberSeries> {
  return createPhisBillingSeriesOf(getPool(), siteId, await siteTimeZone(siteId), input, issuers);
}

export async function editPhisBillingSeries(siteId: number, id: unknown, input: Parameters<typeof editPhisBillingSeriesOf>[4], issuers: readonly string[]): Promise<PhisBillingNumberSeries | null> {
  return editPhisBillingSeriesOf(getPool(), siteId, await siteTimeZone(siteId), id, input, issuers);
}

export async function closePhisBillingSeriesById(siteId: number, id: unknown): Promise<PhisBillingNumberSeries | null> {
  return closePhisBillingSeriesOf(getPool(), siteId, await siteTimeZone(siteId), id);
}

// ---- the Provider's documents (`payments.records.collect`) ----

function validateProviderDocument(value: PhisPaymentProviderDocument): PhisPaymentProviderDocument {
  try {
    if (!value || typeof value !== "object" || !["invoice", "receipt", "credit-note"].includes(value.kind) || (value.state !== "ready" && value.state !== "pending")) throw new Error();
    readPhisBillingText(value.reference, "reference", 255);
    if (value.number !== null) readPhisBillingText(value.number, "number", 40);
    const issuer = value.issuer?.kind === "provider" ? readPhisBillingIssuer(value.issuer, "provider") : readPhisBillingIssuer(value.issuer, "merchant");
    const total = readPhisBillingMoney(value.total, "total");
    const presentment = value.presentment === null ? null : readPhisBillingMoney(value.presentment, "presentment");
    if (value.refund !== null && (typeof value.refund?.reference !== "string" || !value.refund.reference)) throw new Error();
    return { ...value, issuer, total, presentment, issuedAt: readPhisBillingInstant(value.issuedAt, "issuedAt") };
  } catch { throw new PhisPaymentError("provider_unavailable", "Provider returned an invalid document."); }
}

/**
 * One documents task: lists the Provider's documents of the payment, records the new ones `pending` by
 * their reference, fetches what is `ready` into the store and marks it `available`. `done` once every kind
 * the method declared `Fetchable` for the capture (invoice, receipt) or the refund (credit note) is there
 * and available; otherwise asked again.
 */
export function phisProviderDocumentCollector(listeners: () => readonly string[]): PhisPaymentRecordCollector {
  return async ({ task, payment, profile, provider, signal }) => {
    if (!provider.listDocuments || !provider.fetchDocument) throw new PhisPaymentError("unsupported_operation", "The Provider declares documents and does not list them.");
    const declared: PhisPaymentProviderDocument["kind"][] = (payment.features.documents?.kinds ?? [])
      .filter(kind => (kind.flags & PhisPaymentDocumentFeatureFlag.Fetchable) !== 0).map(kind => kind.kind);
    const wanted: PhisPaymentProviderDocument["kind"][] = task.refundId === null ? declared.filter(kind => kind !== "credit-note") : declared.filter(kind => kind === "credit-note");
    if (wanted.length === 0) return "done";
    const call = () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    // db-boundary-exempt: the Provider executes a PSP HTTP call and receives no database handle.
    const listed = (await provider.listDocuments({ binding: payment.binding!, signal: call() })).map(validateProviderDocument);
    const refunds = await listPhisPaymentRefunds(getPool(), payment.record.id);
    const refundOf = (document: PhisPaymentProviderDocument) => document.refund === null ? null
      : refunds.find(refund => refund.binding?.reference === document.refund!.reference)?.record.id ?? "unknown";
    const mine = listed.filter(document => wanted.includes(document.kind) && refundOf(document) === task.refundId);
    const site = await getSiteIdentityById(payment.siteId);
    if (!site) throw new PhisPaymentError("not_found", "The payment's Site is gone.");
    const timeZone = site.timeZone;
    const subscription = payment.record.subscriptionId ? await readPhisPaymentSubscription(getPool(), payment.siteId, payment.record.subscriptionId) : null;
    const actor: PhisBillingActor = { siteId: payment.siteId, addonId: null, actorUserId: null, billingStaff: async () => false, listeners };
    let complete = wanted.every(kind => mine.some(document => document.kind === kind));
    for (const listedDocument of mine) {
      let stored = await withPoolTransaction(getPool(), async db => {
        const existing = await findPhisProviderBillingDocument(db, payment.siteId, profile.providerAddonId, listedDocument.reference, true);
        if (existing) return existing;
        const calendar = phisBillingCalendarOf(new Date(listedDocument.issuedAt), timeZone);
        const document: PhisStoredBillingDocument = {
          siteId: payment.siteId, subjectId: payment.documentSubject ? await findPhisBillingSubjectId(db, payment.siteId, payment.documentSubject) : null,
          providerReference: listedDocument.reference, seriesId: null, seriesYear: null, storageKey: null, idempotencyKey: null, request: null, voidReason: null,
          record: {
            id: randomUUID(), kind: listedDocument.kind, number: listedDocument.number, label: payment.documentLabel ?? (subscription?.record.recurring.description ?? "Payment"),
            issuer: { kind: listedDocument.issuer.kind, name: listedDocument.issuer.name, taxId: listedDocument.issuer.taxId },
            source: { kind: "provider", addonId: profile.providerAddonId }, issuedAt: listedDocument.issuedAt, total: listedDocument.total,
            presentment: listedDocument.presentment, status: "pending", file: null, content: null, paymentState: null, subject: payment.documentSubject,
            consumerAddonId: payment.consumerAddonId,
            // The sale's reference: a subscription's number for its periods and changes, the payment's own otherwise.
            reference: subscription?.record.reference ?? payment.record.reference,
            payment: { paymentId: payment.record.id, refundId: task.refundId },
            subscription: subscription ? { subscriptionId: subscription.record.id, periodIndex: payment.record.periodIndex } : null,
            correctsId: null, retainUntil: phisBillingRetainUntil(calendar.year), flags: 0, createdAt: new Date().toISOString(), version: 1,
          },
        };
        await insertPhisBillingDocument(db, document);
        await owe(db, actor, document);
        return document;
      });
      if (stored.record.status === "available") continue;
      if (listedDocument.state !== "ready") { complete = false; continue; }
      const file = await provider.fetchDocument({ binding: payment.binding!, reference: listedDocument.reference, signal: call() });
      if (!file || (file.contentType !== "application/pdf" && file.contentType !== "text/html") || !(file.body instanceof ReadableStream)) {
        throw new PhisPaymentError("provider_unavailable", "Provider answered a document file of another type.");
      }
      const storageKey = phisBillingStorageKey(site.key, new Date(stored.record.issuedAt).getUTCFullYear(), stored.record.id);
      const written = await putPhisBillingFile({ siteId: payment.siteId, siteKey: site.key, storageKey, contentType: file.contentType, body: file.body, declared: null });
      stored = await withPoolTransaction(getPool(), async db => {
        const current = (await findPhisProviderBillingDocument(db, payment.siteId, profile.providerAddonId, listedDocument.reference, true))!;
        if (current.record.status !== "pending") return current;
        current.storageKey = storageKey;
        current.record.file = { contentType: file.contentType, byteSize: written.byteSize, sha256: written.sha256 };
        current.record.status = "available"; current.record.version += 1;
        await writePhisBillingDocument(db, current);
        await owe(db, actor, current);
        return current;
      });
    }
    return complete ? "done" : "partial";
  };
}

/** A task given up: its Provider documents still `pending` become `failed`, listed for staff to retry. */
export async function failPhisProviderDocuments(siteId: number, paymentId: string, refundId: string | null, listeners: () => readonly string[]) {
  await withPoolTransaction(getPool(), async db => {
    const actor: PhisBillingActor = { siteId, addonId: null, actorUserId: null, billingStaff: async () => false, listeners };
    for (const id of await listPendingPhisProviderBillingDocumentIds(db, siteId, paymentId, refundId)) {
      const document = (await readPhisBillingDocument(db, siteId, id, true))!;
      document.record.status = "failed"; document.record.version += 1;
      await writePhisBillingDocument(db, document);
      await owe(db, actor, document);
    }
  });
}

/** Issued documents still `pending` after 24 hours are voided, reason "not completed" (bounded per run). */
export async function voidIncompletePhisBillingDocuments(listeners: () => readonly string[], limit = 100): Promise<number> {
  const stale = await listStalePendingPhisBillingDocuments(getPool(), new Date(Date.now() - 24 * 3_600_000), limit);
  let voided = 0;
  for (const entry of stale) {
    await withPoolTransaction(getPool(), async db => {
      const document = await readPhisBillingDocument(db, entry.siteId, entry.id, true);
      if (!document || document.record.status !== "pending") return;
      voidDocument(document, "not completed");
      await writePhisBillingDocument(db, document);
      await owe(db, { siteId: entry.siteId, addonId: null, actorUserId: null, billingStaff: async () => false, listeners }, document);
      voided += 1;
    });
  }
  return voided;
}

/**
 * Removes what has outlived its retention -- the file first, then the record -- bounded per run. A record a
 * correction still kept refers to waits for it.
 */
export async function removeExpiredPhisBillingDocuments(limit = 200): Promise<number> {
  const expired = await listExpiredPhisBillingDocuments(getPool(), new Date(), limit);
  let removed = 0;
  for (const entry of expired) {
    const site = await getSiteIdentityById(entry.siteId);
    if (entry.storageKey && entry.byteSize !== null && site) await deletePhisBillingFile(entry.siteId, site.key, entry.storageKey, entry.byteSize);
    await deletePhisBillingDocument(getPool(), entry.id);
    removed += 1;
  }
  return removed;
}

/**
 * A person's deletion request within the retention: their documents on the Site are detached -- listed in
 * nobody's own space, reached by Admin and Accountant through the sale's reference. In the caller's transaction.
 */
export async function detachPhisBillingDocumentsOfUser(db: Db, siteId: number, userId: number, listeners: () => readonly string[]) {
  const subjectId = await findPhisBillingSubjectOfUser(db, siteId, userId);
  if (subjectId === null) return 0;
  const changed = await detachPhisBillingDocumentsOfSubject(db, siteId, subjectId);
  const actor: PhisBillingActor = { siteId, addonId: null, actorUserId: null, billingStaff: async () => false, listeners };
  for (const document of changed) await owe(db, actor, document);
  return changed.length;
}

/** Staff's retry of a document whose fetching was given up: it is `pending` again and its task starts over. */
export async function retryPhisProviderDocument(siteId: number, documentId: unknown, listeners: () => readonly string[]): Promise<PhisBillingDocument | null> {
  if (typeof documentId !== "string") return null;
  return withPoolTransaction(getPool(), async db => {
    const document = await readPhisBillingDocument(db, siteId, documentId, true);
    if (!document) return null;
    if (document.record.source.kind !== "provider" || document.record.status !== "failed" || !document.record.payment) {
      throw new PhisBillingError("invalid_state", "Only a Provider's document whose fetching was given up is retried.");
    }
    document.record.status = "pending"; document.record.version += 1;
    await writePhisBillingDocument(db, document);
    await owe(db, { siteId, addonId: null, actorUserId: null, billingStaff: async () => false, listeners }, document);
    await retryPhisPaymentRecordTasks(db, siteId, document.record.payment.paymentId, "documents");
    return document.record;
  });
}
