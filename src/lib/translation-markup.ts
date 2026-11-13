/**
 * Whether a provider's answer to an `html` unit can stand in the store (TRANSLATIONS.md, "Markdown and
 * HTML"). A structured-document unit is plain HTML whose untranslatable parts are numbered `%n` tokens
 * (phis-ui TRANSLATIONS.md, "Structured documents"): the Site puts the code, the link addresses and the
 * pictures back by number, so an answer that lost a token, gained one, moved a link to another address
 * or left a tag open cannot be read back -- and kept, it would be what every later render reads.
 *
 * Answers the defect, or `null` for an answer that keeps the shape of its source:
 *
 * - the same `%n` tokens, each as often as in the source;
 * - `<b>`, `<i>`, `<s>` and `<a>` opened and closed in turn;
 * - every `<a href="%n">` of the source with the same `%n`.
 *
 * Only this much is checked. Which words carry the emphasis is the translator's business, and a
 * provider may drop or move an emphasis; it may not break what the Site needs to rebuild the text.
 */
export function readHtmlTranslationAnswerDefect(source: string, answer: string): string | null {
  if (!sameMultiset(readTokens(source), readTokens(answer))) {
    return "tokens";
  }
  if (!hasBalancedInlineTags(answer)) {
    return "tags";
  }
  if (!sameMultiset(readTokenHrefs(source), readTokenHrefs(answer))) {
    return "href";
  }
  return null;
}

function readTokens(html: string) {
  return html.match(/%\d+/g) ?? [];
}

const INLINE_TAG_PATTERN = /<(\/?)(b|i|s|a)(?=[\s/>])[^>]*>/gi;

function hasBalancedInlineTags(html: string) {
  const open: string[] = [];
  for (const match of html.matchAll(INLINE_TAG_PATTERN)) {
    const tag = match[2]!.toLowerCase();
    if (!match[1]) {
      open.push(tag);
    } else if (open.pop() !== tag) {
      return false;
    }
  }
  return open.length === 0;
}

function readTokenHrefs(html: string) {
  const hrefs: string[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const href = match[1]!.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    if (/^%\d+$/.test(value)) hrefs.push(value);
  }
  return hrefs;
}

function sameMultiset(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
