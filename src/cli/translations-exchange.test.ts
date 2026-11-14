import { describe, expect, it } from "vitest";

import { readPhiTranslationDefect, readPhiTranslationExchangeFile } from "./translations-exchange.mts";

describe("a translation standing in for its source", () => {
  it("keeps every placeholder, as often as the source has it", () => {
    expect(readPhiTranslationDefect("Delete %n files", "Web UI label", "Supprimer %n fichiers")).toBeNull();
    expect(readPhiTranslationDefect("Hello {name}", "", "Bonjour {name}")).toBeNull();
    expect(readPhiTranslationDefect("Delete %n files", "", "Supprimer les fichiers")).toMatch(/placeholders/);
    expect(readPhiTranslationDefect("%1 of %2", "", "%1 de %1")).toMatch(/placeholders/);
  });

  it("keeps the tags of an html unit, and only there", () => {
    expect(readPhiTranslationDefect("Read <strong>this</strong>", "[html]Web UI message", "Lisez <strong>ceci</strong>"))
      .toBeNull();
    expect(readPhiTranslationDefect("Read <strong>this</strong>", "[html]Web UI message", "Lisez ceci")).toMatch(/tags/);
    expect(readPhiTranslationDefect("Read <strong>this</strong>", "Web UI message", "Lisez ceci")).toBeNull();
  });

  it("is never empty", () => {
    expect(readPhiTranslationDefect("Save", "", "  ")).toMatch(/empty/);
  });
});

describe("an exchange file", () => {
  it("is read only when it is one", () => {
    const file = { version: 1, store: "global", locale: "fr", exportedAt: "x", entries: [{ hash: "a", ctx: "", msg: "Save", translation: null }] };
    expect(readPhiTranslationExchangeFile(JSON.stringify(file)).entries).toHaveLength(1);
    expect(() => readPhiTranslationExchangeFile("{")).toThrow(/not JSON/);
    expect(() => readPhiTranslationExchangeFile(JSON.stringify({ ...file, version: 2 }))).toThrow(/version 1/);
    expect(() => readPhiTranslationExchangeFile(JSON.stringify({ ...file, entries: [{ hash: "a", ctx: "", msg: 1 }] })))
      .toThrow(/Entry 1/);
  });
});

describe("a context in a file", () => {
  it("whose flag envelope is broken carries no flag, so the check does not throw", () => {
    expect(readPhiTranslationDefect("Read <b>x</b>", "[bogus]ctx", "Lisez x")).toBeNull();
  });
});
