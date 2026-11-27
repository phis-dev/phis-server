import { PHIS_BILLING_DOCUMENT_NUMBER_MAX_LENGTH, type PhisBillingNumberSeriesReset } from "@phis/contracts/billing";

/**
 * A number series' template (`PhisBillingNumberSeries.template`, owner 2026-11-27): literal text, the serial
 * `{x...}` whose run of `x` is its minimum width, and the year and month of the issue in the Site's time
 * zone. Pure: what a Form's field rule, the preview route, the CLI and `issue` all ask the same way.
 */

const TOKEN = /\{([^{}]*)\}/gu;
const LITERAL = /^[A-Za-z0-9\-_/.]*$/u;

export type PhisBillingTemplatePart =
  | { kind: "literal"; text: string }
  | { kind: "serial"; width: number }
  | { kind: "year4" }
  | { kind: "year2" }
  | { kind: "month" };

/** Why a template is refused, in words a person reads in a Form beside the field. */
export class PhisBillingTemplateError extends Error {}

/**
 * The template's parts, or the first rule it breaks: exactly one serial of at least one `x`; `{YYYY}`,
 * `{YY}` and `{MM}` at most once each and no other `{...}`; literal text of `A-Z a-z 0-9 - _ / .` only; a
 * yearly reset with a year in it; and the number at the serial's minimum width within 40 characters.
 */
export function parsePhisBillingTemplate(template: unknown, reset: PhisBillingNumberSeriesReset): PhisBillingTemplatePart[] {
  if (typeof template !== "string" || template.length === 0 || template.length > 80) {
    throw new PhisBillingTemplateError("A template is 1 to 80 characters.");
  }
  const parts: PhisBillingTemplatePart[] = [];
  const seen = new Set<string>();
  let last = 0;
  const literal = (text: string) => {
    if (!text) return;
    if (!LITERAL.test(text)) throw new PhisBillingTemplateError(`"${text}" may hold only letters, digits and - _ / . -- no spaces.`);
    parts.push({ kind: "literal", text });
  };
  for (const match of template.matchAll(TOKEN)) {
    literal(template.slice(last, match.index));
    last = match.index + match[0].length;
    const token = match[1]!;
    const kind = /^x+$/u.test(token) ? "serial" : token === "YYYY" ? "year4" : token === "YY" ? "year2" : token === "MM" ? "month" : null;
    if (!kind) throw new PhisBillingTemplateError(`{${token}} is not a token; use {x...}, {YYYY}, {YY} or {MM}.`);
    if (seen.has(kind)) throw new PhisBillingTemplateError(kind === "serial" ? "A template has exactly one serial {x...}." : `{${token}} appears more than once.`);
    seen.add(kind);
    parts.push(kind === "serial" ? { kind, width: token.length } : { kind });
  }
  literal(template.slice(last));
  if (/[{}]/u.test(parts.filter(part => part.kind === "literal").map(part => (part as { text: string }).text).join(""))) {
    throw new PhisBillingTemplateError("A brace stands only around a token.");
  }
  if (!seen.has("serial")) throw new PhisBillingTemplateError("A template has exactly one serial {x...}.");
  if (reset === "yearly" && !seen.has("year4") && !seen.has("year2")) {
    throw new PhisBillingTemplateError("A yearly reset needs {YYYY} or {YY} in the template, or two years would share a number.");
  }
  if (renderPhisBillingNumber(parts, 1, { year: 2000, month: 1 }).length > PHIS_BILLING_DOCUMENT_NUMBER_MAX_LENGTH) {
    throw new PhisBillingTemplateError(`The number would be longer than ${PHIS_BILLING_DOCUMENT_NUMBER_MAX_LENGTH} characters.`);
  }
  return parts;
}

/** The number for a serial issued in a year and month: the serial zero-padded to its minimum width, never cut. */
export function renderPhisBillingNumber(parts: readonly PhisBillingTemplatePart[], serial: number | bigint, at: { year: number; month: number }): string {
  return parts.map(part => {
    switch (part.kind) {
      case "literal": return part.text;
      case "serial": return String(serial).padStart(part.width, "0");
      case "year4": return String(at.year).padStart(4, "0");
      case "year2": return String(at.year % 100).padStart(2, "0");
      case "month": return String(at.month).padStart(2, "0");
    }
  }).join("");
}

/** The year and month of an instant in the Site's time zone: what `{YYYY}`, `{YY}`, `{MM}` and a yearly reset read. */
export function phisBillingCalendarOf(at: Date, timeZone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(at);
  return { year: Number(parts.find(part => part.type === "year")!.value), month: Number(parts.find(part => part.type === "month")!.value) };
}

/** The counter period a serial is counted in: the issue year for a yearly reset, 0 for none. */
export function phisBillingCounterYear(reset: PhisBillingNumberSeriesReset, calendar: { year: number }): number {
  return reset === "yearly" ? calendar.year : 0;
}
