import { describe, expect, it } from "vitest";

import {
  buildPhisTranslationAppContext,
  PHIS_TRANSLATION_APP_CONTEXT_MAX_LENGTH,
  readPhisTranslationAppName,
} from "@/lib/translation-app-context";

/*
 * The name an application writes its global strings under, which becomes half of a database key.
 *
 * `tr_msg` is unique on `(msg_hash, ctx)`, so the name is what keeps a foreign string out of the key
 * space of a Label Set. Two things follow that a plain string would not give: it is normalised, so that
 * `Acme` and `acme` are not two spaces an application searches in vain, and it is refused rather than
 * repaired, because a truncated or mangled name merges spaces instead of separating them.
 */
describe("an application's name", () => {
  it("is absent where nothing was sent", () => {
    expect(readPhisTranslationAppName(null).kind).toBe("absent");
    expect(readPhisTranslationAppName("   ").kind).toBe("absent");
  });

  it("is one space however it was typed", () => {
    for (const raw of ["Acme", " acme ", "ACME"]) {
      expect(readPhisTranslationAppName(raw)).toEqual({ kind: "named", app: "acme" });
    }
    expect(readPhisTranslationAppName("Acme  Docs")).toEqual({ kind: "named", app: "acme docs" });
  });

  it("refuses a name that would forge a storage flag", () => {
    // `[html]` and `[extern]` are the leading envelope this store reads before anything else.
    expect(readPhisTranslationAppName("[html]").kind).toBe("invalid");
    expect(readPhisTranslationAppName("[extern] acme").kind).toBe("invalid");
  });

  it("refuses a name carrying the separator it would be joined with", () => {
    expect(readPhisTranslationAppName("acme: docs").kind).toBe("invalid");
  });

  it("refuses a name longer than the room it has", () => {
    expect(readPhisTranslationAppName("a".repeat(33)).kind).toBe("invalid");
    expect(readPhisTranslationAppName("a".repeat(32)).kind).toBe("named");
  });
});

describe("the context an application writes under", () => {
  it("puts the name in front of what the caller said", () => {
    expect(buildPhisTranslationAppContext("acme", "ui label set")).toEqual({
      kind: "context",
      context: "acme: ui label set",
    });
  });

  it("is the name alone where the caller said nothing", () => {
    // Still inside the application's space, which is what the separator is there to establish.
    expect(buildPhisTranslationAppContext("acme", "   ")).toEqual({
      kind: "context",
      context: "acme",
    });
  });

  it("refuses an overlong pair rather than cutting it", () => {
    const tooLong = "x".repeat(PHIS_TRANSLATION_APP_CONTEXT_MAX_LENGTH);

    expect(buildPhisTranslationAppContext("acme", tooLong).kind).toBe("invalid");
    const fitting = "y".repeat(PHIS_TRANSLATION_APP_CONTEXT_MAX_LENGTH - 6);

    expect(buildPhisTranslationAppContext("acme", fitting)).toEqual({
      kind: "context",
      context: `acme: ${fitting}`,
    });
  });
});
