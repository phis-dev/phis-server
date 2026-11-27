import "server-only";

import { NextResponse } from "next/server";
import type { PhisBillingDocument, PhisBillingDocumentKind } from "@phis/contracts/billing";

import { readPhisBillingDocumentNumbers } from "@/db/billing.mts";
import { getPool } from "@/lib/db";

import { PhisBillingError } from "./validation.ts";
import { PHIS_BILLING_KINDS } from "./validation.ts";

/**
 * What the Billing routes of the Site API share: the refusal of `billing:v1` as an answer, and the list
 * fields a reader sees without the content.
 */

export function phisBillingErrorResponse(error: unknown) {
  if (error instanceof PhisBillingError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  throw error;
}

/**
 * A list row: a document without its structured content (all a Supporter sees), with what a row shows of
 * the content -- `dueAt`, the due date of a merchant's invoice or reminder (`content.payment.dueAt`, else
 * null) -- and `correctsNumber`, the number of the invoice a credit note or reminder refers to (else null).
 */
export type PhisBillingListRow = Omit<PhisBillingDocument, "content"> & { dueAt: string | null; correctsNumber: string | null };

export function phisBillingListFields(document: PhisBillingDocument, correctsNumber: string | null = null): PhisBillingListRow {
  const { content, ...fields } = document;
  return { ...fields, dueAt: content?.payment?.dueAt ?? null, correctsNumber };
}

/** List rows for a page of documents, the corrected invoices' numbers read in one statement. */
export async function phisBillingListRows(siteId: number, documents: readonly PhisBillingDocument[]): Promise<PhisBillingListRow[]> {
  const numbers = await readPhisBillingDocumentNumbers(getPool(), siteId, documents.flatMap(document => document.correctsId ? [document.correctsId] : []));
  return documents.map(document => phisBillingListFields(document, document.correctsId ? numbers.get(document.correctsId) ?? null : null));
}

/** `kinds=invoice,receipt` as a list; `null` for none given. */
export function readPhisBillingKindsParam(value: string | null): PhisBillingDocumentKind[] | null {
  if (!value) return null;
  const kinds = value.split(",").map(entry => entry.trim()).filter(Boolean);
  if (kinds.some(kind => !PHIS_BILLING_KINDS.includes(kind as PhisBillingDocumentKind))) throw new PhisBillingError("invalid_input", `kinds is a list of ${PHIS_BILLING_KINDS.join(", ")}.`);
  return kinds as PhisBillingDocumentKind[];
}

/** `year=2026` as the instants it spans, in UTC; `null` for none given. */
export function readPhisBillingYearParam(value: string | null): { from: string; to: string } | null {
  if (!value) return null;
  if (!/^[0-9]{4}$/.test(value)) throw new PhisBillingError("invalid_input", "year is four digits.");
  const year = Number(value);
  return { from: new Date(Date.UTC(year, 0, 1)).toISOString(), to: new Date(Date.UTC(year + 1, 0, 1)).toISOString() };
}

export function readPhisBillingLimitParam(value: string | null): number {
  if (!value) return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PhisBillingError("invalid_input", "limit is 1 to 100.");
  return limit;
}

export function encodePhisBillingCursor(cursor: { issuedAt: string; id: string } | null) {
  return cursor ? Buffer.from(`${cursor.issuedAt}|${cursor.id}`).toString("base64url") : null;
}

export function decodePhisBillingCursor(value: string | null): { issuedAt: string; id: string } | null {
  if (!value) return null;
  const [issuedAt, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (!issuedAt || !id || !Number.isFinite(Date.parse(issuedAt)) || !/^[0-9a-f-]{36}$/u.test(id)) throw new PhisBillingError("invalid_input", "cursor is the one a listing answered.");
  return { issuedAt, id };
}
