import { describe, expect, it } from "vitest";

import { PhisBillingError, phisBillingRetainUntil, readPhisBillingContent, readPhisBillingIssuer } from "./validation.ts";
import { billingContent } from "../../../test/billing-fixtures.ts";

describe("issued document content", () => {
  it("admits a document whose total is the net plus the taxes", () => {
    const content = readPhisBillingContent(billingContent(), "invoice");
    expect(content.totals.total).toEqual({ currency: "CHF", minor: "3600" });
    expect(content.seller.name).toBe("Phisys AG");
  });

  it("refuses totals that do not add up, another currency, and payment on a receipt", () => {
    const refused = (value: unknown, kind: "invoice" | "receipt" = "invoice") => expect(() => readPhisBillingContent(value, kind)).toThrow(PhisBillingError);
    refused(billingContent({ totals: { net: { currency: "CHF", minor: "3330" }, taxes: [], total: { currency: "CHF", minor: "3600" } } }));
    refused(billingContent({ totals: { net: { currency: "EUR", minor: "3600" }, taxes: [], total: { currency: "EUR", minor: "3600" } } }));
    refused(billingContent({ lines: [] }));
    refused(billingContent({ currency: "XXX" }));
    refused(billingContent({ payment: { dueAt: "2026-12-31T00:00:00Z", reference: null, iban: null, swissQr: null } }), "receipt");
    refused(billingContent({ payment: { dueAt: "2026-12-31T00:00:00Z", reference: null, iban: "CH93 0076 2011 6238 5295 7", swissQr: null } }));
    expect(() => readPhisBillingContent(billingContent({ payment: { dueAt: "2026-12-31T00:00:00Z", reference: "RF18539007547034", iban: "CH9300762011623852957", swissQr: null } }), "invoice")).not.toThrow();
  });

  it("reads the issuer of the kind asked and the retention to the end of the year plus ten", () => {
    expect(readPhisBillingIssuer({ kind: "merchant", name: "Phisys AG", taxId: null }, "merchant")).toEqual({ kind: "merchant", name: "Phisys AG", taxId: null });
    expect(() => readPhisBillingIssuer({ kind: "provider", name: "Link", taxId: null }, "merchant")).toThrow(PhisBillingError);
    expect(phisBillingRetainUntil(2026)).toBe("2037-01-01T00:00:00.000Z");
  });

  it("answers its refusals with the status a route sends", () => {
    expect(new PhisBillingError("invalid_input", "x").status).toBe(400);
    expect(new PhisBillingError("forbidden", "x").status).toBe(403);
    expect(new PhisBillingError("idempotency_conflict", "x").status).toBe(409);
  });
});
