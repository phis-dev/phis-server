import { describe, expect, it } from "vitest";

import { checkPhiDependencyLicenses, classifyPhiLicenseExpression } from "./licenses.mts";

describe("classifyPhiLicenseExpression", () => {
  it("accepts the permissive licences", () => {
    for (const expression of ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause", "0BSD", "CC0-1.0"]) {
      expect(classifyPhiLicenseExpression(expression)).toBe("permissive");
    }
  });

  it("separates strong from weak copyleft", () => {
    expect(classifyPhiLicenseExpression("GPL-3.0-or-later")).toBe("strong-copyleft");
    expect(classifyPhiLicenseExpression("AGPL-3.0")).toBe("strong-copyleft");
    expect(classifyPhiLicenseExpression("LGPL-3.0-or-later")).toBe("weak-copyleft");
    expect(classifyPhiLicenseExpression("MPL-2.0")).toBe("weak-copyleft");
  });

  it("reads share-alike as copyleft and plain attribution as a duty short of it", () => {
    expect(classifyPhiLicenseExpression("CC-BY-SA-4.0")).toBe("strong-copyleft");
    expect(classifyPhiLicenseExpression("CC-BY-4.0")).toBe("weak-copyleft");
  });

  it("takes the mildest branch of an OR, because the choice is ours", () => {
    expect(classifyPhiLicenseExpression("MIT OR GPL-3.0")).toBe("permissive");
    expect(classifyPhiLicenseExpression("GPL-2.0 OR LGPL-2.1")).toBe("weak-copyleft");
  });

  it("takes the strictest branch of an AND, because the duties add up", () => {
    expect(classifyPhiLicenseExpression("(MIT AND GPL-3.0)")).toBe("strong-copyleft");
    expect(classifyPhiLicenseExpression("MIT AND Apache-2.0")).toBe("permissive");
  });

  it("does not guess at anything it cannot name", () => {
    expect(classifyPhiLicenseExpression("SEE LICENSE IN LICENSE")).toBe("unknown");
    expect(classifyPhiLicenseExpression(null)).toBe("unknown");
    expect(classifyPhiLicenseExpression("")).toBe("unknown");
  });
});

describe("checkPhiDependencyLicenses", () => {
  it("finds nothing in the Server's production closure that has not been accepted", () => {
    const report = checkPhiDependencyLicenses();
    expect(report.packageName).toBe("phis");
    expect(report.scannedProduction).toBeGreaterThan(0);
    expect(report.blocking).toEqual([]);
  });

  it("keeps build tooling out of the way, GPL included", () => {
    const report = checkPhiDependencyLicenses();
    const development = report.findings.filter((finding) => finding.scope === "development");
    expect(development.every((finding) => !report.blocking.includes(finding))).toBe(true);
  });
});
