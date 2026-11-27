import { formatPhisMoney } from "@phis/contracts/payments";
import type { PhisBillingDocument, PhisBillingParty } from "@phis/contracts/billing";

/**
 * Core's simple page of an issued document's content, for a receipt or confirmation issued without a file
 * (`billing:v1`): what was issued, printed plainly in the document's locale. Every value is escaped; the
 * page holds no script and loads nothing.
 */

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);

function money(minor: string, currency: string, locale: string) {
  try { return formatPhisMoney({ currency, minor }, locale); } catch { return `${currency} ${minor}`; }
}

function party(value: PhisBillingParty | null) {
  if (!value) return "";
  const lines = [value.name, ...value.addressLines, [value.postalCode, value.city].filter(Boolean).join(" "), value.country, value.taxId ?? ""].filter(Boolean);
  return `<address>${lines.map(escape).join("<br>")}</address>`;
}

export function renderPhisBillingContentPage(document: PhisBillingDocument): string {
  const content = document.content!;
  const locale = content.locale;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(document.issuedAt));
  const rows = content.lines.map(line => `<tr><td>${escape(line.description)}</td><td class="n">${escape(line.quantity)}${line.unit ? ` ${escape(line.unit)}` : ""}</td>`
    + `<td class="n">${escape(money(line.unitMinor, content.currency, locale))}</td><td class="n">${escape(money(line.lineMinor, content.currency, locale))}</td></tr>`).join("");
  const taxes = content.totals.taxes.map(tax => `<tr><td colspan="3">${escape(tax.rate)} %</td><td class="n">${escape(money(tax.tax.minor, content.currency, locale))}</td></tr>`).join("");
  return `<!doctype html><html lang="${escape(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(document.label)}</title><style>
body{font:14px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#222}
table{width:100%;border-collapse:collapse;margin:1rem 0}td{padding:.3rem .4rem;border-bottom:1px solid #ddd}.n{text-align:right;white-space:nowrap}
header{display:flex;justify-content:space-between;gap:1rem}address{font-style:normal}h1{font-size:1.3rem}
</style></head><body><header>${party(content.seller)}${party(content.buyer)}</header>
<h1>${escape(document.label)}${document.number ? ` ${escape(document.number)}` : ""}</h1><p>${escape(date)}</p>
<table>${rows}${taxes}<tr><td colspan="3"></td><td class="n"><strong>${escape(money(content.totals.total.minor, content.currency, locale))}</strong></td></tr></table>
${content.notes ? `<p>${escape(content.notes)}</p>` : ""}</body></html>`;
}
