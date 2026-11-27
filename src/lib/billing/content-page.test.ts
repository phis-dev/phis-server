import { describe, expect, it } from "vitest";
import type { PhisBillingDocument } from "@phis/contracts/billing";

import { renderPhisBillingContentPage } from "./content-page.ts";
import { readPhisBillingContent } from "./validation.ts";
import { billingContent } from "../../../test/billing-fixtures.ts";

describe("Core's page of an issued document's content", () => {
  it("escapes every value and loads nothing", () => {
    const content = readPhisBillingContent(billingContent({ notes: "<script>alert(1)</script>", lines: [{ description: "A & B \"quoted\" <b>", quantity: "1", unit: null,
      unitMinor: "3600", lineMinor: "3600", taxRate: "8.1", taxCategory: "digital-goods", servicePeriod: null }] }), "confirmation");
    const html = renderPhisBillingContentPage({ label: "Confirmation <1>", number: "C-1", issuedAt: "2026-11-27T10:00:00Z", content } as PhisBillingDocument);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("A &amp; B &quot;quoted&quot; &lt;b&gt;");
    expect(html).toContain("Confirmation &lt;1&gt; C-1");
    expect(html).not.toMatch(/<(script|link|img|iframe)\b/u);
    expect(html).toMatch(/CHF\s*36\.00/u);
  });
});
