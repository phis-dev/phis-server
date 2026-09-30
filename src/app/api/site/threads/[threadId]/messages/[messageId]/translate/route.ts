import { NextRequest, NextResponse } from "next/server";

import { PhisThreadMessageFlag } from "@phis/contracts/addon";

import { readSiteAvailableLocales } from "@/db/sites";
import {
  readThreadMessageForTranslation,
  recordDetectedThreadMessageSourceLang,
} from "@/db/threads";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { normalizeString, parseStrictPositiveInt, readRequestBody } from "@/lib/helpers/request";
import { resolvePhiLocaleCapability } from "@/lib/locale";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { resolvePhisTranslationOffer } from "@/lib/translation-offer";
import { requestPhisTranslationUnit } from "@/lib/translation-unit";

export const dynamic = "force-dynamic";

/**
 * One message, read in another language, and nothing kept.
 *
 * The original always remains: no translated text is stored, no marker is written, and nothing records
 * that a translation was shown. That is the accepted cost -- afterwards nobody can say what a support
 * agent actually read -- and it is what keeps a conversation body out of the translation store, which
 * exists for messages that are keyed and versioned.
 *
 * **Core translates rather than the Site**, because the body lives here and `Confidential` says it may
 * not leave. A Site that fetched the body and posted it to a provider itself would have moved it out
 * before any rule could apply, so the rule would be circumvented by the ordinary way of using it.
 *
 * `POST` for a call that stores nothing, because it spends money and reaches a third party. A `GET`
 * would invite a prefetch, a retry and a cache to translate on somebody's behalf.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string; messageId: string }> },
) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { threadId: rawThreadId, messageId: rawMessageId } = await params;
  const threadId = parseStrictPositiveInt(rawThreadId);
  const messageId = parseStrictPositiveInt(rawMessageId);
  if (!threadId || !messageId) {
    return NextResponse.json({ error: "Invalid message id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
  const requestedLocale = resolvePhiLocaleCapability(normalizeString(body.locale))?.locale ?? "";
  if (!requestedLocale) {
    return NextResponse.json({ error: "locale is required." }, { status: 400 });
  }

  /*
   * What this installation offers, asked before the message is read.
   *
   * An installation that cannot translate says so without touching a conversation, and a target the Site
   * does not run is refused for the same reason it is not offered: a translation into a language the Site
   * has no locale for is text nobody here can read afterwards.
   */
  const offer = await resolvePhisTranslationOffer(await readSiteAvailableLocales(site.id));
  if (!offer.available) {
    return NextResponse.json(
      { error: "This site cannot translate messages.", code: "translation_unconfigured" },
      { status: 409 },
    );
  }
  if (!offer.targetLocales.includes(requestedLocale)) {
    return NextResponse.json(
      { error: "That language is not offered here.", code: "translation_locale_unavailable" },
      { status: 400 },
    );
  }

  const source = await readThreadMessageForTranslation({
    siteId: site.id,
    threadId,
    messageId,
    reader: { kind: "user", userId },
  });
  if (!source) {
    return NextResponse.json({ error: "Message not found." }, { status: 404 });
  }

  /*
   * `Confidential` refuses, and refuses here.
   *
   * It is the one flag about where a body may go rather than who may read it, so whoever may read this
   * message still may not have it translated: translating is the body leaving Core. `Internal` does not
   * refuse -- it answers the other question, and whoever may read an internal note may read it in their
   * own language.
   */
  if ((source.flags & PhisThreadMessageFlag.Confidential) !== 0) {
    return NextResponse.json(
      { error: "This message may not be translated.", code: "translation_confidential" },
      { status: 403 },
    );
  }

  const result = await requestPhisTranslationUnit({
    locale: requestedLocale,
    msgs: [source.body],
    /*
     * `ctx` stays in the unit's request and is left empty here, for now.
     *
     * The surrounding messages were the obvious thing to put in it -- the field is request-wide and
     * measurably free -- and that argument is about the bill rather than about the answer. What nobody has
     * measured is what a provider does with a context that is long and in a third language, which in a
     * mixed thread is what the message before this one usually is. So the field keeps its place and this
     * caller says nothing until somebody measures what saying something does.
     */
    /*
     * What an integration recorded, and null otherwise.
     *
     * Null is the contract's way of saying "you decide", and it is the ordinary case: nobody writing on a
     * Site is asked which language they are writing in, because every provider detects it for itself. The
     * Site's default must never stand in here -- it would tell a translator German about Portuguese text.
     */
    sourceLocale: source.sourceLang,
    format: "text",
    // A conversation body is this installation's and nobody else's, so the shared CDN step never sees it.
    audience: "private",
  });

  if (!result.succeeded) {
    const unconfigured = result.outcome === "unconfigured";
    logRuntimeEvent(unconfigured ? "warn" : "error", "site.thread.message.translation_failed", {
      area: "threads",
      message: "A message translation did not succeed.",
      siteKey: site.key,
      userId,
      meta: { threadId, messageId, targetLocale: requestedLocale, outcome: result.outcome },
    });
    return NextResponse.json(
      unconfigured
        ? { error: "This site cannot translate messages.", code: "translation_unconfigured" }
        : { error: "The translation could not be fetched.", code: "translation_failed" },
      { status: unconfigured ? 409 : 503 },
    );
  }

  const [text = ""] = result.translations;
  const [detected = null] = result.detectedSourceLocales;

  /*
   * What the provider recognised is kept, where the message declared nothing.
   *
   * Not for the sake of the next translation -- the language comes back free with every one of them -- but
   * because a stored value is the only kind a filter can use, and without this the column stays empty for
   * everything a person ever wrote. It carries `LangDetected`, so whatever routes on it can tell a guess
   * from an integration's assertion, and it never replaces a declared value.
   *
   * Best effort on purpose. The reader asked to read this message, and a column that did not get filled in
   * is not a reason to answer them with an error.
   */
  if (detected && source.sourceLang == null) {
    void recordDetectedThreadMessageSourceLang({
      siteId: site.id,
      threadId,
      messageId,
      locale: detected,
    }).catch((cause: unknown) => {
      logRuntimeEvent("warn", "site.thread.message.source_lang_not_recorded", {
        area: "threads",
        message: "A recognised message language could not be stored.",
        siteKey: site.key,
        userId,
        error: normalizeLogThrowable(cause),
        meta: { threadId, messageId, detected },
      });
    });
  }

  return NextResponse.json({
    translation: {
      messageId,
      targetLocale: requestedLocale,
      /*
       * Which language it came out of, where anybody said so.
       *
       * The provider's detection first, because it looked at this text, and what an integration recorded
       * second. Null where neither knows, and a surface that cannot name the source simply does not name
       * it -- a translation marked as machine-made is honest without it.
       */
      sourceLocale: detected ?? source.sourceLang,
      text,
    },
  });
}
