import { NextResponse } from "next/server";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import {
  listPublishedNews,
  PHI_NEWS_TRANSLATION_CONTEXTS,
  type SiteNewsFieldValue,
} from "@/db/site-content";
import { resolvePhiLocaleBase, resolveRequestLocale } from "@/lib/locale";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { requireSiteFromRequest } from "@/lib/site-context";
import {
  trackTranslationStandIns,
  translateExternalSiteBatchWithCache,
  translateSiteBatchWithCache,
} from "@/lib/translations";

const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";

type PublishedNews = Awaited<ReturnType<typeof listPublishedNews>>;
type PublishedNewsEntry = PublishedNews[number];

/**
 * A field still waiting for the language it was asked in, and where its answer belongs.
 *
 * Collected across every entry before anything is asked for, so one locale costs one request per context
 * rather than one per entry.
 */
type PendingField = {
  entryIndex: number;
  text: string;
} & (
  | { field: "title" | "subtitle" }
  /** A tag is answered in place, so the slot it goes back into is its position in the entry's list. */
  | { field: "tag"; tagIndex: number }
);

function readEntrySourceLocale(entry: PublishedNewsEntry, canonicalLocale: string) {
  return entry.sourceLocale?.trim() || canonicalLocale;
}

/**
 * Whether this entry's words already are the answer for the language asked for.
 *
 * Two cases, and neither is worth a provider: the reader asked in the language the entry was written in,
 * or the entry says it may not be translated.
 */
function answersInSourceLanguage(entry: PublishedNewsEntry, locale: string, canonicalLocale: string) {
  return !entry.translate
    || resolvePhiLocaleBase(readEntrySourceLocale(entry, canonicalLocale)) === resolvePhiLocaleBase(locale);
}

function collectPendingFields(entries: PublishedNews, locale: string, canonicalLocale: string) {
  const pending = new Map<string, { sourceLocale: string; ctx: string; fields: PendingField[] }>();
  entries.forEach((entry, entryIndex) => {
    if (answersInSourceLanguage(entry, locale, canonicalLocale)) {
      return;
    }
    const sourceLocale = readEntrySourceLocale(entry, canonicalLocale);
    const candidates: ReadonlyArray<["title" | "subtitle", SiteNewsFieldValue, string]> = [
      ["title", entry.title, PHI_NEWS_TRANSLATION_CONTEXTS.title],
      ["subtitle", entry.subtitle, PHI_NEWS_TRANSLATION_CONTEXTS.subtitle],
    ];
    const add = (ctx: string, field: PendingField) => {
      const key = `${sourceLocale}\u0000${ctx}`;
      const group = pending.get(key) ?? { sourceLocale, ctx, fields: [] };
      group.fields.push(field);
      pending.set(key, group);
    };

    for (const [field, value, ctx] of candidates) {
      // Already translated, or nothing to translate. A human correction through the translations editor
      // lands on the same row, so it wins here without the provider being asked again.
      if (value.translated || !value.source.trim()) {
        continue;
      }
      add(ctx, { entryIndex, field, text: value.source });
    }

    /*
     * Tags travel with the fields, under their own context.
     *
     * They are plain strings in the content row's `meta` rather than message rows of a version, and they
     * need no preparation for that: the translator ensures a message for whatever it is handed, so a tag
     * becomes one the first time it is read in another language. Two entries carrying the same tag share
     * that one message, which is why the context must stay a phrase and not name an entry.
     */
    entry.tags.forEach((tag, tagIndex) => {
      if (tag.trim()) {
        add(PHI_NEWS_TRANSLATION_CONTEXTS.tag, { entryIndex, field: "tag", tagIndex, text: tag });
      }
    });
  });
  return [...pending.values()];
}

/**
 * Fills the languages nobody has asked for yet, at the moment somebody does.
 *
 * Pull rather than push, which is what makes the rest of the design work: a draft is never read publicly
 * and so costs nothing, the first reader in a language pays one request, and everyone after them reads
 * the cache. A corrected entry is a new message row, so nothing has to be invalidated -- the next reader
 * simply finds nothing cached and asks again.
 *
 * The body is deliberately not here. Markdown is translated paragraph by paragraph where it is rendered,
 * with the structure never handed to a provider at all, so what this answers for `content` is the source
 * as it was written, beside the language it was written in.
 */
async function translatePendingFields(input: {
  siteId: number;
  locale: string;
  canonicalLocale: string;
  entries: PublishedNews;
}) {
  const groups = collectPendingFields(input.entries, input.locale, input.canonicalLocale);
  if (groups.length === 0) {
    return;
  }

  for (const group of groups) {
    const texts = group.fields.map((entry) => entry.text);
    const sameAsCanonical =
      resolvePhiLocaleBase(group.sourceLocale) === resolvePhiLocaleBase(input.canonicalLocale);
    const translations = sameAsCanonical
      ? await translateSiteBatchWithCache({
        siteId: input.siteId,
        locale: input.locale,
        sourceLocale: input.canonicalLocale,
        msgs: texts,
        ctx: group.ctx,
        format: "text",
      })
      /*
       * Written in another language than the Site's canonical one: the same route external Markdown
       * takes. The text is translated into the canonical language once and kept as its own message, the
       * original stays the answer for its own language, and every further language derives from the
       * canonical one.
       */
      : await translateExternalSiteBatchWithCache({
        siteId: input.siteId,
        locale: input.locale,
        sourceLocale: group.sourceLocale,
        canonicalLocale: input.canonicalLocale,
        msgs: texts,
        ctx: group.ctx,
        format: "text",
      });

    group.fields.forEach((field, index) => {
      const translation = translations[index]?.trim();
      const entry = input.entries[field.entryIndex];
      if (!translation || !entry) {
        return;
      }
      if (field.field === "tag") {
        entry.tags[field.tagIndex] = translation;
        return;
      }
      entry[field.field] = { ...entry[field.field], text: translation, translated: true };
    });
  }
}

export async function GET(request: Request) {
  const guardError = guardApiV1(request);
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json(
      { error: "Missing site context." },
      { status: 400 },
    );
  }

  const locale = resolveRequestLocale(request.headers);
  /*
   * How many the caller will show. Optional for a caller that wants the list, refused when it is not a
   * count: a `limit` that silently meant "all" would let a typo re-translate the whole history.
   */
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    return NextResponse.json({ error: "limit must be a positive integer." }, { status: 400 });
  }
  const entries = await listPublishedNews(site.id, locale, limit === undefined ? {} : { limit });
  const { value: translationFailed, standIn } = await trackTranslationStandIns(async () => {
    try {
      await translatePendingFields({
        siteId: site.id,
        locale,
        canonicalLocale: site.sourceLocale,
        entries,
      });
    } catch (error) {
      /*
       * A failed translation is not a failed answer. The entries are read and correct in the language
       * they were written in, and a News page that renders them is better than one that reports an
       * outage -- which is why this is caught here and marked below rather than raised.
       */
      logRuntimeEvent("error", "news.translation.failed", {
        area: "news",
        message: "News translation failed; answering in the source language.",
        siteKey: site.key,
        error: normalizeLogThrowable(error),
        meta: { locale, entries: entries.length },
      });
      return true;
    }
    return false;
  });

  /*
   * Two ways to end up with source text where a translation was asked for: the provider reported a
   * failure, which the translator records itself, or the whole step threw and was caught above. Both mean
   * the same thing for a caller, so both say `provisional`.
   */
  const provisional = standIn || translationFailed;

  const items = entries.map((entry) => ({
    id: entry.id,
    slug: entry.slug,
    created: entry.created,
    outdated: entry.outdated,
    title: entry.title.text,
    subtitle: entry.subtitle.text,
    // The source, so the renderer translates the Markdown paragraph by paragraph from the language below.
    content: entry.content.source,
    link: entry.link,
    /*
     * The words a reader can read. What a filter address would need is the tag as it was written, which is
     * its identity and stays in the entry's `meta`; there is no such address yet, and inventing the field
     * before it exists would be a second answer nobody asked for.
     */
    tags: entry.tags,
    sourceLocale: entry.sourceLocale,
    translate: entry.translate,
  }));
  const version = items[0]?.created?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);

  return createJsonResponse(
    request,
    {
      version,
      site: site.key,
      locale,
      news: items,
      // `provisional`: at least one answer is source text standing in for a failure; do not keep it.
      ...(provisional ? { provisional: true } : {}),
    },
    { cacheControl: provisional ? "no-store" : CACHE_CONTROL },
  );
}
