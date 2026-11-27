import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import {
  PhisBillingNumberSeriesFlag, type PhisBillingNumberSeries, type PhisBillingNumberSeriesReset, type PhisBillingNumberedDocumentKind,
} from "@phis/contracts/billing";

import {
  closePhisBillingSeries, insertPhisBillingSeries, listPhisBillingSeries, lockPhisBillingSeriesKey, peekPhisBillingSerial, readOpenPhisBillingSeriesByKey,
  readPhisBillingSeries, updatePhisBillingSeries, writePhisBillingSeriesSources, type PhisStoredBillingSeries,
} from "../../db/billing.mts";
import { withPoolTransaction } from "../db-transaction.ts";
import {
  parsePhisBillingTemplate, phisBillingCalendarOf, phisBillingCounterYear, PhisBillingTemplateError, renderPhisBillingNumber,
} from "./number-template.ts";
import { PHIS_BILLING_NUMBERED_KINDS, PhisBillingError, readPhisBillingText } from "./validation.ts";

/**
 * A Site's number series (`billing:v1`, PAYMENTS.md, number series): defining, changing, closing, listing
 * with the next number, and the preview. Not `server-only`: the Accounting routes and `phis billing series`
 * do the same through these functions, each handing in the pool and the Site's time zone.
 */

type Db = Pick<PoolClient, "query">;


const SERIES_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/u;

function readSeriesKinds(value: unknown): PhisBillingNumberedDocumentKind[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(kind => !PHIS_BILLING_NUMBERED_KINDS.includes(kind))) {
    throw new PhisBillingError("invalid_input", "kinds is at least one of invoice, credit-note, reminder.");
  }
  return [...new Set(value as PhisBillingNumberedDocumentKind[])];
}

function readReset(value: unknown): PhisBillingNumberSeriesReset {
  if (value !== "none" && value !== "yearly") throw new PhisBillingError("invalid_input", "reset is none or yearly.");
  return value;
}

function readTemplate(template: unknown, reset: PhisBillingNumberSeriesReset) {
  try { return parsePhisBillingTemplate(template, reset); }
  catch (error) { throw new PhisBillingError("invalid_input", error instanceof PhisBillingTemplateError ? error.message : "The template is refused."); }
}

/** The number a template would give the next issue now, from the series' counter where it has one. */
async function nextNumber(db: Db, siteId: number, template: unknown, reset: PhisBillingNumberSeriesReset, seriesId: string | null, timeZone: string) {
  const parts = readTemplate(template, reset);
  const calendar = phisBillingCalendarOf(new Date(), timeZone);
  const serial = seriesId ? await peekPhisBillingSerial(db, seriesId, phisBillingCounterYear(reset, calendar)) : BigInt(1);
  return renderPhisBillingNumber(parts, serial, calendar);
}

async function seriesRecord(db: Db, series: PhisStoredBillingSeries, timeZone: string): Promise<PhisBillingNumberSeries> {
  return {
    id: series.id, key: series.key, label: series.label, template: series.template, reset: series.reset, kinds: series.kinds, sources: series.sources,
    next: await nextNumber(db, series.siteId, series.template, series.reset, series.id, timeZone), flags: series.flags, createdAt: series.createdAt, closedAt: series.closedAt,
  };
}

/** A Site's series as staff and the CLI read them, newest first, each with its next number. */
export async function listPhisBillingSeriesOf(pool: Pool, siteId: number, timeZone: string, filter: { open?: boolean; source?: string } = {}): Promise<PhisBillingNumberSeries[]> {
  const series = await listPhisBillingSeries(pool, siteId, filter);
  return Promise.all(series.map(entry => seriesRecord(pool, entry, timeZone)));
}

/** What `preview` answers: the next number of a template now, or the rule it breaks. */
export async function previewPhisBillingSeriesOf(pool: Pool, siteId: number, timeZone: string, input: { template: unknown; reset: unknown }): Promise<{ next: string }> {
  const reset = readReset(input?.reset);
  return { next: await nextNumber(pool, siteId, input.template, reset, null, timeZone) };
}

/**
 * A new series; with `replaces`, the open series of the same key is closed in the same step -- the way a
 * used template is changed. At most one open series per key. `issuers` are the installed Add-ons whose
 * manifest declares `billing.issues`, the only ones a series may name.
 */
export async function createPhisBillingSeriesOf(pool: Pool, siteId: number, timeZone: string,
  input: { key: unknown; label: unknown; template: unknown; reset: unknown; kinds: unknown; sources?: unknown; replaces?: unknown },
  issuers: readonly string[]): Promise<PhisBillingNumberSeries> {
  if (typeof input?.key !== "string" || !SERIES_KEY.test(input.key)) throw new PhisBillingError("invalid_input", "key is a slug of 1 to 64 lowercase letters, digits and dashes.");
  const label = readPhisBillingText(input.label, "label");
  const reset = readReset(input.reset);
  readTemplate(input.template, reset);
  const kinds = readSeriesKinds(input.kinds);
  const sources = readSources(input.sources ?? [], issuers);
  return withPoolTransaction(pool, async db => {
    await lockPhisBillingSeriesKey(db, siteId, input.key as string);
    const open = await readOpenPhisBillingSeriesByKey(db, siteId, input.key as string, true);
    if (input.replaces !== undefined && input.replaces !== null) {
      if (!open || open.id !== input.replaces) throw new PhisBillingError("invalid_state", "replaces is the open series of this key.");
      await closePhisBillingSeries(db, open.id);
    } else if (open) {
      throw new PhisBillingError("invalid_state", `The key "${input.key}" has an open series; replace it to change its template.`);
    }
    const id = randomUUID();
    await insertPhisBillingSeries(db, { id, siteId, key: input.key as string, label, template: input.template as string, reset, kinds, sources });
    return seriesRecord(db, (await readPhisBillingSeries(db, siteId, id))!, timeZone);
  });
}

function readSources(value: unknown, issuers: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || !issuers.includes(entry))) {
    throw new PhisBillingError("invalid_input", "sources names installed Add-ons whose manifest declares billing.issues.");
  }
  return [...new Set(value as string[])];
}

/** Label, kinds and sources of a series; once `Used`, kinds only grow. Key, template and reset never change here. */
export async function editPhisBillingSeriesOf(pool: Pool, siteId: number, timeZone: string, id: unknown,
  input: { label?: unknown; kinds?: unknown; sources?: unknown }, issuers: readonly string[]): Promise<PhisBillingNumberSeries | null> {
  if (typeof id !== "string") return null;
  return withPoolTransaction(pool, async db => {
    const series = await readPhisBillingSeries(db, siteId, id, true);
    if (!series) return null;
    if ((series.flags & PhisBillingNumberSeriesFlag.Closed) !== 0) throw new PhisBillingError("invalid_state", "A closed series is not changed.");
    const label = input.label === undefined ? series.label : readPhisBillingText(input.label, "label");
    const kinds = input.kinds === undefined ? series.kinds : readSeriesKinds(input.kinds);
    if ((series.flags & PhisBillingNumberSeriesFlag.Used) !== 0 && series.kinds.some(kind => !kinds.includes(kind))) {
      throw new PhisBillingError("invalid_state", "A series that has numbered documents keeps its kinds; it only gains more.");
    }
    await updatePhisBillingSeries(db, id, { label, kinds });
    if (input.sources !== undefined) await writePhisBillingSeriesSources(db, id, readSources(input.sources, issuers));
    return seriesRecord(db, (await readPhisBillingSeries(db, siteId, id))!, timeZone);
  });
}

export async function closePhisBillingSeriesOf(pool: Pool, siteId: number, timeZone: string, id: unknown): Promise<PhisBillingNumberSeries | null> {
  if (typeof id !== "string") return null;
  return withPoolTransaction(pool, async db => {
    const series = await readPhisBillingSeries(db, siteId, id, true);
    if (!series) return null;
    await closePhisBillingSeries(db, id);
    return seriesRecord(db, (await readPhisBillingSeries(db, siteId, id))!, timeZone);
  });
}
