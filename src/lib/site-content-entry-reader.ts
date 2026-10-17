import "server-only";

import {
  SITE_CONTENT_ENTRY_KINDS,
  type SiteContentEntryFieldValue,
  type SiteContentEntryKind,
  type SiteContentPublishedEntry,
} from "@/db/site-content-entries";
import { resolvePhiLocaleBase } from "@/lib/locale";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { resolvePhiMediaThumbnailUrl } from "@/lib/media-response";
import {
  trackTranslationStandIns,
  translateExternalSiteBatchWithCache,
  translateSiteBatchWithCache,
} from "@/lib/translations";

/*
 * What every public read of a content type's entries does after the store has answered (CONTENT.md):
 * translate the words a reader sees into the language asked for, and put an entry into the shape a Site
 * reads. The list (`/api/v1/entries/<kind>`) and one entry with its relatives
 * (`/api/v1/entries/<kind>/<slug>`) share it, so an entry reads the same whichever address it came from.
 */

/** How long a public answer may be kept; a provisional one is never kept. */
export const SITE_CONTENT_ENTRY_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";

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
  | { field: "title" | "subtitle" | "category" }
  /** A tag is answered in place, so the slot it goes back into is its position in the entry's list. */
  | { field: "tag"; tagIndex: number }
);

function readEntrySourceLocale(entry: SiteContentPublishedEntry, canonicalLocale: string) {
  return entry.sourceLocale?.trim() || canonicalLocale;
}

/**
 * Whether this entry's words already are the answer for the language asked for.
 *
 * Two cases, and neither is worth a provider: the reader asked in the language the entry was written in,
 * or the entry says it may not be translated.
 */
function answersInSourceLanguage(entry: SiteContentPublishedEntry, locale: string, canonicalLocale: string) {
  return !entry.translate
    || resolvePhiLocaleBase(readEntrySourceLocale(entry, canonicalLocale)) === resolvePhiLocaleBase(locale);
}

function collectPendingFields(
  kind: SiteContentEntryKind,
  entries: readonly SiteContentPublishedEntry[],
  locale: string,
  canonicalLocale: string,
) {
  const contexts = SITE_CONTENT_ENTRY_KINDS[kind].contexts;
  const pending = new Map<string, { sourceLocale: string; ctx: string; fields: PendingField[] }>();
  entries.forEach((entry, entryIndex) => {
    if (answersInSourceLanguage(entry, locale, canonicalLocale)) {
      return;
    }
    const sourceLocale = readEntrySourceLocale(entry, canonicalLocale);
    const candidates: ReadonlyArray<["title" | "subtitle", SiteContentEntryFieldValue, string]> = [
      ["title", entry.title, contexts.title],
      ["subtitle", entry.subtitle, contexts.subtitle],
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
     * Terms travel with the fields, each vocabulary under its own context.
     *
     * A term's label is plain source text on its row rather than a message of a version, and it needs no
     * preparation for that: the translator ensures a message for whatever it is handed, so a label becomes
     * one the first time it is read in another language. Every entry carrying the term shares that one
     * message, which is why the context must stay a phrase and not name an entry.
     */
    entry.tags.forEach((tag, tagIndex) => {
      if (tag.label.trim()) {
        add(contexts.tag, { entryIndex, field: "tag", tagIndex, text: tag.label });
      }
    });
    if (entry.category?.label.trim()) {
      add(contexts.category, { entryIndex, field: "category", text: entry.category.label });
    }
  });
  return [...pending.values()];
}

/**
 * Fills the languages nobody has asked for yet, at the moment somebody does -- in place, on the entries
 * handed in.
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
  kind: SiteContentEntryKind;
  siteId: number;
  locale: string;
  canonicalLocale: string;
  entries: SiteContentPublishedEntry[];
}) {
  const groups = collectPendingFields(input.kind, input.entries, input.locale, input.canonicalLocale);
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
        const tag = entry.tags[field.tagIndex];
        if (tag) entry.tags[field.tagIndex] = { ...tag, label: translation };
        return;
      }
      if (field.field === "category") {
        if (entry.category) entry.category = { ...entry.category, label: translation };
        return;
      }
      entry[field.field] = { ...entry[field.field], text: translation, translated: true };
    });
  }
}

/**
 * Translates the entries for the language asked for, in place, and says whether any answer is source text
 * standing in for a failure.
 *
 * A failed translation is not a failed answer. The entries are read and correct in the language they were
 * written in, and a page that renders them is better than one that reports an outage -- which is why a
 * throw is caught here and reported as `provisional` rather than raised.
 */
export async function translatePublishedSiteContentEntries(input: {
  kind: SiteContentEntryKind;
  site: { id: number; key: string; sourceLocale: string };
  locale: string;
  entries: SiteContentPublishedEntry[];
}): Promise<{ provisional: boolean }> {
  const { value: translationFailed, standIn } = await trackTranslationStandIns(async () => {
    try {
      await translatePendingFields({
        kind: input.kind,
        siteId: input.site.id,
        locale: input.locale,
        canonicalLocale: input.site.sourceLocale,
        entries: input.entries,
      });
    } catch (error) {
      logRuntimeEvent("error", "content.entries.translation.failed", {
        area: input.kind,
        message: "Content entry translation failed; answering in the source language.",
        siteKey: input.site.key,
        error: normalizeLogThrowable(error),
        meta: { locale: input.locale, entries: input.entries.length },
      });
      return true;
    }
    return false;
  });
  // Two ways to end up with source text where a translation was asked for, and one meaning for a caller.
  return { provisional: standIn || translationFailed };
}

/** The picture beside a byline, or `null` where the Asset is no image a thumbnail can be cut from. */
function serializeAuthorAvatar(avatar: NonNullable<SiteContentPublishedEntry["author"]>["avatar"]) {
  const url = avatar
    ? resolvePhiMediaThumbnailUrl({
      id: avatar.assetId,
      deliveryRevision: avatar.deliveryRevision,
      variantVersion: avatar.variantVersion,
      contentType: avatar.contentType,
    })
    : null;
  return url ? { url } : null;
}

/** One entry in the shape a Site reads (phis-ui `PhiSiteContentEntry`). */
export function serializePublishedSiteContentEntry(entry: SiteContentPublishedEntry) {
  return {
    id: entry.id,
    slug: entry.slug,
    created: entry.created,
    outdated: entry.outdated,
    title: entry.title.text,
    subtitle: entry.subtitle.text,
    // The source, so the renderer translates the Markdown paragraph by paragraph from the language below.
    content: entry.content.source,
    link: entry.link,
    // The address stays as written -- it is the term's identity, and a later archive's -- the label is read.
    category: entry.category,
    tags: entry.tags,
    author: entry.author ? { name: entry.author.name, avatar: serializeAuthorAvatar(entry.author.avatar) } : null,
    sourceLocale: entry.sourceLocale,
    translate: entry.translate,
  };
}
