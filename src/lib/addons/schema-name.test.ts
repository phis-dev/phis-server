import { describe, expect, it } from "vitest";

import { isPhisAddonStorageKeyUnder, phisAddonStoragePrefix } from "./schema-name.ts";

describe("isPhisAddonStorageKeyUnder", () => {
  const acme = phisAddonStoragePrefix("@acme/exports", "acme");

  it("admits a key under the Site's own directory", () => {
    expect(isPhisAddonStorageKeyUnder(acme, `${acme}/2026/report.csv`)).toBe(true);
  });

  it("refuses a key of a Site whose key merely begins the same way", () => {
    const acmeEu = phisAddonStoragePrefix("@acme/exports", "acme-eu");
    expect(acmeEu.startsWith(acme)).toBe(true);
    expect(isPhisAddonStorageKeyUnder(acme, `${acmeEu}/2026/report.csv`)).toBe(false);
  });

  it("refuses the prefix itself, which names a directory and not an object", () => {
    expect(isPhisAddonStorageKeyUnder(acme, acme)).toBe(false);
  });
});
