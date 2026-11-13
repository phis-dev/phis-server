import { describe, expect, it } from "vitest";

import { readHtmlTranslationAnswerDefect } from "@/lib/translation-markup";

/*
 * An `html` unit's answer is stored only if the Site can read it back (TRANSLATIONS.md, "Markdown and
 * HTML"): the same `%n` tokens, the inline tags opened and closed in turn, every link at its own token.
 */
describe("readHtmlTranslationAnswerDefect", () => {
  const source = '%1 reads a <a href="%2">Page</a> <b>now</b>, with %3.';

  it("accepts an answer that moved the tokens and the emphasis", () => {
    expect(readHtmlTranslationAnswerDefect(source, '<b>Jetzt</b> liest %1 mit %3 eine <a href="%2">Seite</a>.')).toBeNull();
  });

  it("accepts an answer that dropped an emphasis", () => {
    expect(readHtmlTranslationAnswerDefect(source, '%1 liest jetzt eine <a href="%2">Seite</a>, mit %3.')).toBeNull();
  });

  it("accepts plain text and an HTML Widget's own markup", () => {
    expect(readHtmlTranslationAnswerDefect("Plain text", "Schlichter Text")).toBeNull();
    expect(readHtmlTranslationAnswerDefect(
      '<strong>Read</strong> <a href="https://example.org">this</a>',
      '<strong>Lies</strong> <a href="https://example.org">das</a>',
    )).toBeNull();
  });

  it.each([
    ["a missing token", '%1 liest eine <a href="%2">Seite</a> <b>jetzt</b>.', "tokens"],
    ["a doubled token", '%1 liest %1 eine <a href="%2">Seite</a> <b>jetzt</b>, mit %3.', "tokens"],
    ["a token that was not there", '%1 liest eine <a href="%4">Seite</a> <b>jetzt</b>, mit %3.', "tokens"],
    ["a tag left open", '%1 liest eine <a href="%2">Seite</a> <b>jetzt, mit %3.', "tags"],
    ["tags closed out of turn", '%1 liest <b>eine <a href="%2">Seite</b></a>, mit %3.', "tags"],
    ["a link at another token", '%2 liest eine <a href="%1">Seite</a> <b>jetzt</b>, mit %3.', "href"],
  ])("rejects %s", (_case, answer, defect) => {
    expect(readHtmlTranslationAnswerDefect(source, answer)).toBe(defect);
  });
});
