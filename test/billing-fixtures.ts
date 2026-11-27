/** A merchant invoice's content that adds up: CHF 33.30 net, 8.1 % tax, CHF 36.00. */
export function billingContent(overrides: Record<string, unknown> = {}) {
  return {
    locale: "de-CH", currency: "CHF", basis: "final",
    seller: { name: "Phisys AG", addressLines: ["Bahnhofstrasse 1"], postalCode: "8000", city: "Zürich", country: "CH", taxId: "CHE-123.456.789 MWST" },
    buyer: null,
    lines: [{ description: "PhiVoice AI Pro, yearly", quantity: "1", unit: null, unitMinor: "3600", lineMinor: "3600", taxRate: "8.1", taxCategory: "digital-goods", servicePeriod: null }],
    totals: { net: { currency: "CHF", minor: "3330" }, taxes: [{ rate: "8.1", base: { currency: "CHF", minor: "3330" }, tax: { currency: "CHF", minor: "270" } }], total: { currency: "CHF", minor: "3600" } },
    servicePeriod: null, notes: null, payment: null,
    ...overrides,
  };
}
