import { describe, expect, it } from "vitest";

import { isPhiNonBlankString, requirePhiString } from "./string";

describe("a required string field", () => {
  it.each([undefined, null, 3, "", "   ", ["x"]])("refuses %j", (value) => {
    expect(isPhiNonBlankString(value)).toBe(false);
    expect(() => requirePhiString(value, "title")).toThrow("title is required.");
  });

  it("hands the string back trimmed", () => {
    expect(isPhiNonBlankString(" Home ")).toBe(true);
    expect(requirePhiString(" Home ", "title")).toBe("Home");
  });
});
