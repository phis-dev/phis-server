import { NextRequest, NextResponse } from "next/server";

import { SITE_CONTENT_STATUS_DRAFT, SITE_CONTENT_STATUS_PUBLISHED } from "@/db/site-content";
import {
  deleteSiteContentEntry,
  listSiteContentEntriesForEditor,
  listSiteContentEntryTagsInUse,
  normalizePhiContentEntryTag,
  saveSiteContentEntryDraft,
  type SiteContentEntryKind,
} from "@/db/site-content-entries";
import { readEntryKind, type EntryRouteContext } from "@/lib/site-content-entry-route";
import { requireSiteAuthorApiContext } from "@/lib/guards/site-admin-api";
import { resolvePhiLocaleBase, resolvePhiLocaleCapability } from "@/lib/locale";
import {
  normalizeNullableInteger,
  normalizeString,
  parsePhiPagination,
  parsePositiveIntWithFallback,
  readRequestBody,
} from "@/lib/helpers/request";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/*
 * The words of a content type's entry (CONTENT.md), under its kind: `/api/site/editor/entries/news`.
 *
 * Every method here is behind `requireSiteAuthorApiContext` and none of them touches `status`,
 * `published_at` or `expires_at`: when an entry is seen is stated at `entries/<kind>/publish`, behind the
 * publishing policy. A delete is refused while an entry is published, because removing something from a
 * Site is that same authority's act wearing a different verb.
 *
 * Two of the values a save carries are about the words rather than the entry: the language they are
 * written in, and whether a reader in another one may be served a translation. Both land in the version's
 * own `meta`, and both are stated again by every save.
 *
 * **A save states the whole entry**, which is why it is a `PUT` and not a `PATCH`. A save writes a version,
 * and a version is a complete set of words rather than a patch on the last one -- so a subtitle left out is
 * a subtitle this version does not have. `link`, `tags` and `sortOrder` follow the same rule, because one
 * call with two meanings is how a save that only corrected a typo silently dropped an entry's link. The one
 * exception is the address: an entry must have a slug, so a save that names none keeps it.
 *
 * **A save of an entry that exists names the version it read** (`versionId`, the key the editor's rows
 * answer it under, so a Form bound to a row sends it back unasked). One that does not build
 * on the current version is refused with `409` and writes nothing: two Authors may work on one entry, and
 * neither overwrites the other unseen.
 *
 * **One `PUT`, whether the entry exists yet or not.** With a `contentId` it is that entry; without one it is
 * a new entry at the slug it names, and a slug somebody else holds is refused with `409`. There is no second
 * method for creating, because a Form binds one handler and one path -- two would mean two Forms and two
 * dialogs for one act, and a surface where "save" means different things depending on how you got there.
 */

const ENTRY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;
const MAX_ENTRY_TAGS = 12;
const MAX_ENTRY_TAG_LENGTH = 40;
const MAX_ENTRY_TITLE_LENGTH = 200;
const MAX_ENTRY_SUBTITLE_LENGTH = 300;
const MAX_ENTRY_CONTENT_LENGTH = 20_000;

type EntryDraftBody = {
  contentId: number | null;
  baseVersionId: number | null;
  slug: string | null;
  title: string;
  subtitle: string | null;
  content: string;
  link: string | null;
  tags: string[];
  sortOrder: number;
  sourceLocale: string | null;
  translate: boolean;
};

/**
 * A stated yes or no, or nothing at all.
 *
 * Both spellings arrive: a declared Form sends JSON booleans, a client holding a stored value may send
 * the string it read. Anything else is read as unstated, which means the default -- and the default for
 * translating is yes, as it is for the Markdown Widget's own switch.
 */
function readOptionalBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  const text = normalizeString(value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return undefined;
}

/**
 * A link is either the Site's own path or an absolute `http(s)` address, and nothing else.
 *
 * It is rendered as an `href` on a public page, so a scheme nobody validated is a scheme somebody chose.
 * A protocol-relative `//host` is refused with the rest: it reads like a path and resolves like a host.
 */
function readEntryLink(value: unknown): { link: string | null } | { error: string } {
  const link = normalizeString(value);
  if (!link) {
    return { link: null };
  }
  if (link.startsWith("/")) {
    return link.startsWith("//")
      ? { error: "link must not be protocol-relative." }
      : { link };
  }

  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return { error: "link must be a site-relative path or an http(s) URL." };
  }

  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? { link: parsed.toString() }
    : { error: "link must be a site-relative path or an http(s) URL." };
}

function readEntryTags(value: unknown): { tags: string[] } | { error: string } {
  if (value === undefined || value === null) {
    return { tags: [] };
  }
  if (!Array.isArray(value)) {
    return { error: "tags must be an array of strings." };
  }

  const tags: string[] = [];
  for (const entry of value) {
    // The same normalisation the store applies, so what is refused here is refused for its real length.
    const tag = normalizePhiContentEntryTag(entry);
    if (!tag) {
      continue;
    }
    if (tag.length > MAX_ENTRY_TAG_LENGTH) {
      return { error: `A tag must be at most ${MAX_ENTRY_TAG_LENGTH} characters.` };
    }
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }

  return tags.length > MAX_ENTRY_TAGS
    ? { error: `At most ${MAX_ENTRY_TAGS} tags are allowed.` }
    : { tags };
}

function readEntryDraftBody(
  body: Record<string, unknown>,
  options: { requireSlug: boolean; canonicalLocale: string },
): { input: EntryDraftBody } | { error: string; code?: string } {
  // A Form's hidden field sends the id as a string, a client holding it sends a number; both arrive here.
  const contentId = normalizeNullableInteger(body.contentId);
  const slug = normalizeString(body.slug).toLowerCase();
  const title = normalizeString(body.title);
  const subtitle = normalizeString(body.subtitle);
  const content = normalizeString(body.content);

  if (options.requireSlug || slug) {
    if (!ENTRY_SLUG_PATTERN.test(slug)) {
      return {
        error: "slug must be lower-case letters, digits and hyphens, and start with a letter or digit.",
      };
    }
  }
  if (!options.requireSlug && (contentId === null || contentId <= 0)) {
    return { error: "A valid contentId, or a slug for a new entry, is required." };
  }
  if (!title || title.length > MAX_ENTRY_TITLE_LENGTH) {
    return { error: `title is required and must be at most ${MAX_ENTRY_TITLE_LENGTH} characters.` };
  }
  if (subtitle.length > MAX_ENTRY_SUBTITLE_LENGTH) {
    return { error: `subtitle must be at most ${MAX_ENTRY_SUBTITLE_LENGTH} characters.` };
  }
  if (!content || content.length > MAX_ENTRY_CONTENT_LENGTH) {
    return { error: `content is required and must be at most ${MAX_ENTRY_CONTENT_LENGTH} characters.` };
  }

  const link = readEntryLink(body.link);
  if ("error" in link) {
    return link;
  }

  /*
   * The language the words are written in, which an author states rather than Core guessing. Empty means
   * the Site's canonical one. A language the platform cannot translate is refused here rather than stored:
   * the read path would silently answer every reader in it, which looks like a translation failure and is
   * a typo.
   */
  const declaredLocale = normalizeString(body.sourceLocale);
  const sourceLocale = declaredLocale
    ? resolvePhiLocaleCapability(declaredLocale)?.locale ?? null
    : null;
  if (declaredLocale && !sourceLocale) {
    return { error: "sourceLocale must be a language this installation can translate." };
  }

  const translate = readOptionalBoolean(body.translate) ?? true;
  if (!translate && sourceLocale && resolvePhiLocaleBase(sourceLocale) !== resolvePhiLocaleBase(options.canonicalLocale)) {
    /*
     * A stated no to translating, together with a language that is not the Site's own, contradicts itself:
     * the entry would be answered in that language to every reader, including the ones who cannot read it.
     * Refused rather than stored, because the alternative is a row that claims one thing and means another.
     */
    return {
      error: "An entry that may not be translated must be written in the Site's own language.",
      code: "untranslatable_foreign_source",
    };
  }
  const tags = readEntryTags(body.tags);
  if ("error" in tags) {
    return tags;
  }

  return {
    input: {
      contentId: contentId !== null && contentId > 0 ? contentId : null,
      baseVersionId: readPositiveInteger(body.versionId),
      slug: slug || null,
      title,
      subtitle: subtitle || null,
      content,
      link: link.link,
      tags: tags.tags,
      sortOrder: normalizeNullableInteger(body.sortOrder) ?? 0,
      sourceLocale,
      translate,
    },
  };
}

function readPositiveInteger(value: unknown) {
  const number = normalizeNullableInteger(value);
  return number !== null && number > 0 ? number : null;
}

/**
 * One status, or every one of them.
 *
 * Spelled rather than numbered at the door: a Table's filter carries what a person chose, and `draft` says
 * what `0` means. Anything else is read as no filter, because a listing is not the place to refuse.
 */
function readStatusFilter(value: string | null) {
  const status = normalizeString(value).toLowerCase();
  if (status === "draft") return SITE_CONTENT_STATUS_DRAFT;
  if (status === "published") return SITE_CONTENT_STATUS_PUBLISHED;
  return null;
}

export async function GET(request: NextRequest, { params }: EntryRouteContext) {
  const entryKind = await readEntryKind(params);
  if ("error" in entryKind) {
    return entryKind.error;
  }
  const { kind } = entryKind;
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const { page, pageSize } = parsePhiPagination(searchParams);

  /*
   * The Site's source locale, never a requested one. What this surface edits is source text, and showing a
   * translated title in a form that writes the source would overwrite the original with its translation
   * on the next save. Translating an entry is the translations editor's work on the same messages.
   */
  const [listing, tags] = await Promise.all([
    listSiteContentEntriesForEditor({
      kind,
      siteId: site.id,
      locale: site.sourceLocale,
      page,
      pageSize,
      search: searchParams.get("search"),
      status: readStatusFilter(searchParams.get("status")),
    }),
    // The offer a tag field picks from, answered beside the page so a picker needs no second endpoint.
    listSiteContentEntryTagsInUse(kind, site.id),
  ]);

  return NextResponse.json({
    sourceLocale: site.sourceLocale,
    entries: listing.rows,
    total: listing.total,
    page: listing.page,
    pageSize: listing.pageSize,
    tags,
  });
}

async function writeEntryDraft(request: NextRequest, kind: SiteContentEntryKind) {
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const parsed = readEntryDraftBody(body, {
    // No id means a new entry, and a new entry needs the address it is to live at.
    requireSlug: normalizeNullableInteger(body.contentId) === null,
    canonicalLocale: site.sourceLocale,
  });
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) },
      { status: 400 },
    );
  }

  const outcome = await saveSiteContentEntryDraft({
    kind,
    siteId: site.id,
    contentId: parsed.input.contentId,
    baseVersionId: parsed.input.baseVersionId,
    slug: parsed.input.slug,
    title: parsed.input.title,
    subtitle: parsed.input.subtitle,
    content: parsed.input.content,
    link: parsed.input.link,
    tags: parsed.input.tags,
    sortOrder: parsed.input.sortOrder,
    sourceLocale: parsed.input.sourceLocale,
    translate: parsed.input.translate,
    createdByUserId: context.session?.userId ?? null,
  });

  if (!outcome.ok) {
    if (outcome.reason === "conflict") {
      return NextResponse.json(
        {
          error: "The entry changed since it was read.",
          code: "conflict",
          currentVersionId: outcome.currentVersionId,
        },
        { status: 409 },
      );
    }
    return outcome.reason === "slug_taken"
      ? NextResponse.json({ error: "An entry with that slug already exists.", code: "slug_taken" }, { status: 409 })
      : NextResponse.json({ error: "Entry not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.editor.entry.saved", {
    area: "editor",
    message: "Content entry draft saved.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: {
      kind,
      contentId: outcome.contentId,
      versionId: outcome.versionId,
      slug: outcome.slug,
      created: parsed.input.contentId === null,
    },
  });

  return NextResponse.json({
    contentId: outcome.contentId,
    versionId: outcome.versionId,
    slug: outcome.slug,
  });
}

export async function PUT(request: NextRequest, { params }: EntryRouteContext) {
  const entryKind = await readEntryKind(params);
  return "error" in entryKind ? entryKind.error : writeEntryDraft(request, entryKind.kind);
}

export async function DELETE(request: NextRequest, { params }: EntryRouteContext) {
  const entryKind = await readEntryKind(params);
  if ("error" in entryKind) {
    return entryKind.error;
  }
  const { kind } = entryKind;
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const contentId = parsePositiveIntWithFallback(searchParams.get("contentId"), 0);
  if (contentId <= 0) {
    return NextResponse.json({ error: "A valid contentId is required." }, { status: 400 });
  }

  const outcome = await deleteSiteContentEntry({ kind, siteId: site.id, contentId });
  if (outcome === "missing") {
    return NextResponse.json({ error: "Entry not found." }, { status: 404 });
  }
  if (outcome === "published") {
    return NextResponse.json(
      { error: "A published entry must be withdrawn before it can be deleted.", code: "published" },
      { status: 409 },
    );
  }

  logRuntimeEvent("info", "site.editor.entry.deleted", {
    area: "editor",
    message: "Content entry draft deleted.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { kind, contentId },
  });

  return NextResponse.json({ deletedCount: 1 });
}
