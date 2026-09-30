import { describe, expect, it } from "vitest";

import {
  isPhiEmailAddress,
  normalizePhiEmail,
  normalizePhiSiteKey,
  slugifyPhiSiteKey,
} from "./normalize";

describe("stored spellings", () => {
  it("stores an email trimmed and in lower case", () => {
    expect(normalizePhiEmail("  Ada@Example.ORG ")).toBe("ada@example.org");
  });

  it("looks a Site key up without rewriting it", () => {
    expect(normalizePhiSiteKey(" Main Site ")).toBe("main site");
    expect(normalizePhiSiteKey(null)).toBe("");
    expect(normalizePhiSiteKey(undefined)).toBe("");
  });

  it("makes a key for a new Site out of what was typed", () => {
    expect(slugifyPhiSiteKey("  My Shop!  (EU) ")).toBe("my-shop-eu");
    expect(slugifyPhiSiteKey("--main--")).toBe("main");
  });
});

describe("the shape of an email address", () => {
  it.each(["ada@example.org", "a.b+c@sub.example.co"])("takes %s", (value) => {
    expect(isPhiEmailAddress(value)).toBe(true);
  });

  it.each(["", "ada", "ada@example", "@example.org", "ada@@example.org", "ada @example.org"])(
    "refuses %j",
    (value) => {
      expect(isPhiEmailAddress(value)).toBe(false);
    },
  );
});
