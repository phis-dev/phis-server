import { describe, expect, it } from "vitest";

import { parsePhisBillingTemplate, phisBillingCalendarOf, phisBillingCounterYear, PhisBillingTemplateError, renderPhisBillingNumber } from "./number-template.ts";

const at = { year: 2026, month: 11 };
const render = (template: string, serial: number, reset: "none" | "yearly" = "none", when = at) =>
  renderPhisBillingNumber(parsePhisBillingTemplate(template, reset), serial, when);

describe("number series templates (PLANS 8.5)", () => {
  it("renders the owner's examples", () => {
    expect(render("PHS-{YYYY}-{xxxxx}", 42)).toBe("PHS-2026-00042");
    expect(render("R{YY}{MM}-{xxxx}", 42)).toBe("R2611-0042");
    expect(render("PHI-{YY}{xxxxx}", 1, "yearly")).toBe("PHI-2600001");
    expect(render("PHI-{YY}{xxxxx}", 99999, "yearly")).toBe("PHI-2699999");
  });

  it("keeps counting past the minimum width and never cuts the serial", () => {
    expect(render("PHI-{YY}{xxxxx}", 100000, "yearly")).toBe("PHI-26100000");
    expect(render("{x}", 1234567)).toBe("1234567");
    expect(renderPhisBillingNumber(parsePhisBillingTemplate("A{xx}", "none"), BigInt("12345678901234567890"), at)).toBe("A12345678901234567890");
  });

  it("refuses what the rules refuse", () => {
    const refused = (template: unknown, reset: "none" | "yearly" = "none") => expect(() => parsePhisBillingTemplate(template, reset)).toThrow(PhisBillingTemplateError);
    refused("INV-{YYYY}");
    refused("{xx}-{xxx}");
    refused("{x}-{DD}");
    refused("{YYYY}{YYYY}-{x}");
    // Each year token at most once, both together allowed, as the contract states.
    expect(parsePhisBillingTemplate("{YYYY}{YY}-{x}", "yearly").length).toBeGreaterThan(0);
    refused("{MM}{MM}{x}");
    refused("INV-{xxxx}", "yearly");
    refused("INV {x}");
    refused("INV#{x}");
    refused("INV-{x");
    refused("{}{x}");
    refused("");
    refused(42);
    refused(`${"A".repeat(40)}{x}`);
  });

  it("admits literal text of letters, digits and - _ / . and a yearly reset with a year", () => {
    expect(() => parsePhisBillingTemplate("a/B_c.d-{YY}{x}", "yearly")).not.toThrow();
    expect(() => parsePhisBillingTemplate(`${"A".repeat(39)}{x}`, "none")).not.toThrow();
    expect(() => parsePhisBillingTemplate(`${"A".repeat(36)}{YYYY}{x}`, "yearly")).toThrow(PhisBillingTemplateError);
  });

  it("reads the year and month in the Site's time zone across New Year", () => {
    const newYear = new Date("2026-12-31T23:30:00Z");
    expect(phisBillingCalendarOf(newYear, "UTC")).toEqual({ year: 2026, month: 12 });
    expect(phisBillingCalendarOf(newYear, "Europe/Zurich")).toEqual({ year: 2027, month: 1 });
    expect(phisBillingCalendarOf(new Date("2027-01-01T03:00:00Z"), "America/New_York")).toEqual({ year: 2026, month: 12 });
    expect(phisBillingCounterYear("yearly", { year: 2027 })).toBe(2027);
    expect(phisBillingCounterYear("none", { year: 2027 })).toBe(0);
  });
});
