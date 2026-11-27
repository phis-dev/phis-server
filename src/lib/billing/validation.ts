import type {
  PhisBillingDocumentContent, PhisBillingDocumentIssuer, PhisBillingDocumentKind, PhisBillingDocumentLine, PhisBillingParty, PhisBillingPaymentState,
} from "@phis/contracts/billing";
import type { PhisPaymentMoney } from "@phis/contracts/payments";
import { PHIS_PAYMENT_CURRENCY_EXPONENTS } from "@phis/contracts/payments";
import { PHIS_PAYMENT_TAX_CATEGORIES } from "../constants/payments.ts";

/** What `billing:v1` refuses, with the code a route answers by (`PhisBillingError.status`). */
export type PhisBillingErrorCode = "invalid_input" | "forbidden" | "not_found" | "invalid_state" | "idempotency_conflict" | "unavailable";

export class PhisBillingError extends Error {
  readonly code: PhisBillingErrorCode;
  constructor(code: PhisBillingErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "PhisBillingError";
  }
  get status() {
    return { invalid_input: 400, forbidden: 403, not_found: 404, invalid_state: 409, idempotency_conflict: 409, unavailable: 503 }[this.code];
  }
}

export const PHIS_BILLING_KINDS: readonly PhisBillingDocumentKind[] = ["invoice", "credit-note", "reminder", "receipt", "confirmation"];
export const PHIS_BILLING_NUMBERED_KINDS: readonly PhisBillingDocumentKind[] = ["invoice", "credit-note", "reminder"];
export const PHIS_BILLING_PAYMENT_STATES: readonly PhisBillingPaymentState[] = ["open", "partially-paid", "paid", "written-off"];

const invalid = (message: string): never => { throw new PhisBillingError("invalid_input", message); };
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/;
const MINOR = /^(0|[1-9][0-9]{0,15})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readPhisBillingText(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) invalid(`${field} is 1 to ${max} characters of text.`);
  return value as string;
}

function readOptionalText(value: unknown, field: string, max = 200): string | null {
  return value === null ? null : readPhisBillingText(value, field, max);
}

export function readPhisBillingInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) invalid(`${field} is an ISO instant with a zone.`);
  return new Date(value as string).toISOString();
}

export function readPhisBillingMinor(value: unknown, field: string): string {
  if (typeof value !== "string" || !MINOR.test(value)) invalid(`${field} is a whole number of minor units.`);
  return value as string;
}

function readCurrency(value: unknown, field: string): string {
  if (typeof value !== "string" || !Object.hasOwn(PHIS_PAYMENT_CURRENCY_EXPONENTS, value)) invalid(`${field} is a currency a payment accepts.`);
  return value as string;
}

export function readPhisBillingMoney(value: unknown, field: string, currency?: string): PhisPaymentMoney {
  if (!isRecord(value)) return invalid(`${field} is { currency, minor }.`);
  const money = { currency: readCurrency(value.currency, `${field}.currency`), minor: readPhisBillingMinor(value.minor, `${field}.minor`) };
  if (currency && money.currency !== currency) invalid(`${field} is in ${currency}, the document's currency.`);
  return money;
}

function readParty(value: unknown, field: string): PhisBillingParty {
  if (!isRecord(value)) return invalid(`${field} is a party.`);
  if (!Array.isArray(value.addressLines) || value.addressLines.length > 6) invalid(`${field}.addressLines is a list of at most 6 lines.`);
  if (typeof value.country !== "string" || !/^[A-Z]{2}$/.test(value.country)) invalid(`${field}.country is an ISO 3166-1 alpha-2 code.`);
  return {
    name: readPhisBillingText(value.name, `${field}.name`),
    addressLines: (value.addressLines as unknown[]).map((line, index) => readPhisBillingText(line, `${field}.addressLines[${index}]`)),
    postalCode: readOptionalText(value.postalCode, `${field}.postalCode`, 32),
    city: readOptionalText(value.city, `${field}.city`, 100),
    country: value.country as string,
    taxId: readOptionalText(value.taxId, `${field}.taxId`, 64),
  };
}

function readPeriod(value: unknown, field: string): { from: string; to: string } | null {
  if (value === null) return null;
  if (!isRecord(value)) return invalid(`${field} is { from, to } or null.`);
  const period = { from: readPhisBillingInstant(value.from, `${field}.from`), to: readPhisBillingInstant(value.to, `${field}.to`) };
  if (Date.parse(period.to) < Date.parse(period.from)) invalid(`${field} ends before it starts.`);
  return period;
}

const DECIMAL = /^[0-9]{1,12}(\.[0-9]{1,6})?$/;

function readLine(value: unknown, field: string): PhisBillingDocumentLine {
  if (!isRecord(value)) return invalid(`${field} is a line.`);
  if (typeof value.quantity !== "string" || !DECIMAL.test(value.quantity)) invalid(`${field}.quantity is a decimal string.`);
  if (value.taxRate !== null && (typeof value.taxRate !== "string" || !/^[0-9]{1,3}(\.[0-9]{1,4})?$/.test(value.taxRate))) invalid(`${field}.taxRate is a decimal string or null.`);
  if (typeof value.taxCategory !== "string" || !(PHIS_PAYMENT_TAX_CATEGORIES as readonly string[]).includes(value.taxCategory)) invalid(`${field}.taxCategory is one of ${PHIS_PAYMENT_TAX_CATEGORIES.join(", ")}.`);
  return {
    description: readPhisBillingText(value.description, `${field}.description`, 500),
    quantity: value.quantity as string,
    unit: readOptionalText(value.unit, `${field}.unit`, 16),
    unitMinor: readPhisBillingMinor(value.unitMinor, `${field}.unitMinor`),
    lineMinor: readPhisBillingMinor(value.lineMinor, `${field}.lineMinor`),
    taxRate: value.taxRate as string | null,
    taxCategory: value.taxCategory as PhisBillingDocumentLine["taxCategory"],
    servicePeriod: readPeriod(value.servicePeriod, `${field}.servicePeriod`),
  };
}

/**
 * What an issued document says, normalized: every part in its place and in the document's currency, the
 * total the sum of the net and the taxes. Core does not recompute a line; what is printed is the issuer's.
 */
export function readPhisBillingContent(value: unknown, kind: PhisBillingDocumentKind): PhisBillingDocumentContent {
  if (!isRecord(value)) return invalid("content is the document's structured content.");
  if (typeof value.locale !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value.locale)) invalid("content.locale is a locale such as de-CH.");
  const currency = readCurrency(value.currency, "content.currency");
  if (value.basis !== "final" && value.basis !== "net") invalid("content.basis is final or net.");
  if (!Array.isArray(value.lines) || value.lines.length === 0 || value.lines.length > 500) invalid("content.lines is a list of 1 to 500 lines.");
  if (!isRecord(value.totals) || !Array.isArray(value.totals.taxes) || value.totals.taxes.length > 20) invalid("content.totals is { net, taxes, total }.");
  const totals = value.totals as Record<string, unknown>;
  const taxes = (totals.taxes as unknown[]).map((entry, index) => {
    if (!isRecord(entry) || typeof entry.rate !== "string" || !/^[0-9]{1,3}(\.[0-9]{1,4})?$/.test(entry.rate)) return invalid(`content.totals.taxes[${index}] is { rate, base, tax }.`);
    return { rate: entry.rate, base: readPhisBillingMoney(entry.base, `content.totals.taxes[${index}].base`, currency), tax: readPhisBillingMoney(entry.tax, `content.totals.taxes[${index}].tax`, currency) };
  });
  const net = readPhisBillingMoney(totals.net, "content.totals.net", currency);
  const total = readPhisBillingMoney(totals.total, "content.totals.total", currency);
  if (BigInt(net.minor) + taxes.reduce((sum, entry) => sum + BigInt(entry.tax.minor), BigInt(0)) !== BigInt(total.minor)) {
    invalid("content.totals.total is the net plus the taxes.");
  }
  let payment: PhisBillingDocumentContent["payment"] = null;
  if (value.payment !== null) {
    if (kind !== "invoice" && kind !== "reminder") invalid("content.payment is only for an invoice or a reminder.");
    if (!isRecord(value.payment)) return invalid("content.payment is { dueAt, reference, iban, swissQr } or null.");
    const iban = value.payment.iban;
    if (iban !== null && (typeof iban !== "string" || !/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(iban))) invalid("content.payment.iban is an IBAN without spaces, or null.");
    payment = {
      dueAt: readPhisBillingInstant(value.payment.dueAt, "content.payment.dueAt"),
      reference: readOptionalText(value.payment.reference, "content.payment.reference", 40),
      iban: iban as string | null,
      swissQr: readOptionalText(value.payment.swissQr, "content.payment.swissQr", 997),
    };
  }
  return {
    locale: value.locale as string, currency, basis: value.basis as "final" | "net",
    seller: readParty(value.seller, "content.seller"),
    buyer: value.buyer === null ? null : readParty(value.buyer, "content.buyer"),
    lines: (value.lines as unknown[]).map((line, index) => readLine(line, `content.lines[${index}]`)),
    totals: { net, taxes, total },
    servicePeriod: readPeriod(value.servicePeriod, "content.servicePeriod"),
    notes: readOptionalText(value.notes, "content.notes", 2000),
    payment,
  };
}

export function readPhisBillingIssuer(value: unknown, kind: "merchant" | "provider"): PhisBillingDocumentIssuer {
  if (!isRecord(value) || value.kind !== kind) return invalid(`issuer is { kind: "${kind}", name, taxId }.`);
  return { kind, name: readPhisBillingText(value.name, "issuer.name"), taxId: readOptionalText(value.taxId, "issuer.taxId", 64) };
}

/** The end of the calendar year of the issue plus ten years, in the Site's time zone's year (OR 958f, MWSTG 70). */
export function phisBillingRetainUntil(issueYear: number): string {
  return new Date(Date.UTC(issueYear + 11, 0, 1)).toISOString();
}
