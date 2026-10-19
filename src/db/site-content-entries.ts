import "server-only";

import { getPool, withTransaction } from "@/lib/db";
import { toPhiRecord } from "@/lib/helpers/record";
import { resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import { readPhiLinkTarget, type PhiLinkTarget } from "@/lib/internal-references";
import {
  collectSiteCmsReferences,
  PhiCmsReferenceSourceKind,
  replaceSiteCmsReferencesWithDb,
} from "@/db/site-cms-references";
import {
  insertSiteContentVersion,
  normalizeOptionalText,
  setSiteContentCurrentVersion,
  upsertSiteContentTextField,
  SITE_CONTENT_STATUS_DRAFT,
  SITE_CONTENT_STATUS_PUBLISHED,
  SITE_CONTENT_TYPE_BLOG,
  SITE_CONTENT_TYPE_NEWS,
  SITE_CONTENT_VOCABULARY_CATEGORY,
  SITE_CONTENT_VOCABULARY_TAG,
  type DbQueryable,
} from "@/db/site-content";
import { PhiMediaDeliveryPolicy, PhiMediaLifecycleStatus } from "@/db/media-spaces";
import { replaceSiteContentEntryTags, setSiteContentEntryCategory } from "@/db/site-content-terms";
import { userDisplayNameSql } from "@/db/user-profiles";
import { USER_SITE_FLAG_DISABLED } from "@/lib/user-site-flags";
import { PHI_CORE_ROLE_PROVIDER_ID, PhiBaseRole } from "@phis/contracts/access";

/*
 * Content types: entries that are content only, written by Authors and published by Publishers
 * (CONTENT.md). They have no structure of their own -- a Page that lists them or shows one is ordinary
 * structure -- and they all keep the same words: a title, an optional subtitle and a Markdown body, with a
 * link and tags on the entry.
 *
 * Two authorities over two sets of columns. A save writes words: one new version, its text fields, and
 * `current_version_id` pointing at it. A publish writes when the entry is seen: `status`,
 * `published_version_id`, `published_at` and `expires_at`. They are separate functions because CONTENT.md
 * gives them to separate roles, and one statement covering both sets of columns would be reachable by
 * whoever may do the lesser of the two. What the public reads is `published_version_id`, so an edit made
 * after a publish is written, kept, and not seen until it is published in turn.
 */

/**
 * The content types and what each keeps its words under.
 *
 * A translation context is natural language rather than a structural key, and deliberately **not per
 * entry**. The context is part of a message's identity, so `news:81:title` would give every entry its own
 * row and pay for the same sentence twice; a phrase shared by all titles keeps the dedupe and is the
 * better hint for the provider. The read path states the same values when it asks for a translation, so
 * the cached answer lands on the row the entry already points at.
 */
export const SITE_CONTENT_ENTRY_KINDS = {
  news: {
    type: SITE_CONTENT_TYPE_NEWS,
    contexts: {
      title: "news entry title",
      subtitle: "news entry subtitle",
      content: "news entry body",
      /*
       * A tag is a word the entry carries, not a field of its version: it lives in the content row's `meta`
       * as a plain string and becomes a message the first time somebody reads it in another language.
       */
      tag: "news tag",
      category: "news category",
    },
  },
  /*
   * A blog post: the same words as a News entry -- a title, a teaser as its subtitle, a Markdown body --
   * kept apart because a Site lists, addresses and translates them apart. A post's address is
   * `/blog/<slug>`, which is why its slug is authored like a News entry's.
   */
  blog: {
    type: SITE_CONTENT_TYPE_BLOG,
    contexts: {
      title: "blog post title",
      subtitle: "blog post teaser",
      content: "blog post body",
      tag: "blog tag",
      category: "blog category",
    },
  },
} as const satisfies Record<string, {
  type: number;
  contexts: { title: string; subtitle: string; content: string; tag: string; category: string };
}>;

export type SiteContentEntryKind = keyof typeof SITE_CONTENT_ENTRY_KINDS;

export function isSiteContentEntryKind(value: unknown): value is SiteContentEntryKind {
  return typeof value === "string" && Object.hasOwn(SITE_CONTENT_ENTRY_KINDS, value);
}

export type SiteContentEntryInput = {
  kind: SiteContentEntryKind;
  siteId: number;
  contentId?: number | null;
  slug?: string | null;
  /** The version the writer read; required for an entry that exists (CONTENT.md, Concurrent writers). */
  baseVersionId?: number | null;
  title: string;
  subtitle?: string | null;
  content: string;
  /** A Page target or an external address (REFERENCES.md); a Page target without an Area means Public. */
  link?: PhiLinkTarget | null;
  tags?: readonly string[];
  sortOrder?: number;
  /**
   * The language these words are written in, or null for the Site's canonical one.
   *
   * Declared, never guessed. It is what lets an author write in their own language: a read in another
   * one then goes the external route -- translated into the canonical language first, the original kept
   * as the answer for its own language.
   */
  sourceLocale?: string | null;
  /** Whether a reader in another language may be served a translation at all. Absent means yes. */
  translate?: boolean;
  createdByUserId?: number | null;
};

/** What a version records about its own words, beside the words themselves. */
export type SiteContentEntryVersionTerms = {
  sourceLocale: string | null;
  translate: boolean;
};

/**
 * One field of an entry as the store answers it. `translated` is the part the read path needs: a field
 * that fell back to its source is a field nobody has translated yet, and only the reader knows whether
 * that is worth a provider call.
 */
export type SiteContentEntryFieldValue = {
  /** What a reader in the asked-for language gets: a translation where one exists, the source otherwise. */
  text: string;
  /** The words as they were written, whatever language that is. */
  source: string;
  translated: boolean;
};

/** A term an entry carries, as a reader is given it: its address and its label, still in the words written. */
export type SiteContentEntryTerm = {
  slug: string;
  label: string;
};

/**
 * The picture an author is shown with: a Public, ready image Asset bound as their avatar on this Site.
 * The parts a delivery address is built from, not the address, so the route builds it the one way it is
 * built everywhere.
 */
export type SiteContentEntryAuthorAvatar = {
  assetId: number;
  deliveryRevision: number;
  variantVersion: number | null;
  contentType: string;
};

/**
 * Who an entry is attributed to, as a reader may see it: the name the person is shown under and their
 * picture. Never an address -- a person without a name to show is no byline at all.
 */
export type SiteContentEntryAuthor = {
  name: string;
  avatar: SiteContentEntryAuthorAvatar | null;
};

export type SiteContentEntryWriteOutcome =
  | { ok: true; contentId: number; versionId: number; slug: string }
  | { ok: false; reason: "missing" | "slug_taken" }
  | { ok: false; reason: "conflict"; currentVersionId: number | null };

export type SiteContentEntryPublication = {
  contentId: number;
  status: number;
  publishedVersionId: number;
  publishedAt: string | null;
  expiresAt: string | null;
};

export type SiteContentEntryEditorRecord = SiteContentEntryVersionTerms & {
  contentId: number;
  /** Who the entry is attributed to (CONTENT.md, Curation), or `null` for nobody. */
  authorUserId: number | null;
  /** That person's name as administration names them -- an address where they have no name -- or `null`. */
  author: string | null;
  /** The category the entry is filed under, by its id, or `null` for none. */
  categoryId: number | null;
  category: string | null;
  slug: string;
  status: number;
  sortOrder: number;
  title: string;
  subtitle: string;
  content: string;
  link: PhiLinkTarget | null;
  tags: string[];
  publishedAt: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
  hasUnpublishedChanges: boolean;
  /**
   * The version this row shows -- the draft's. A Form bound to the row sends it back by the same key: as
   * the base of a save, and as the version a submission or a publish names.
   */
  versionId: number | null;
  publishedVersionId: number | null;
  /** The version an Author put forward for publication, or `null`. */
  submittedVersionId: number | null;
};

function toIsoDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeRequiredText(value: string | null | undefined, fieldName: string) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(`${fieldName} must not be empty.`);
  }
  return normalized;
}

function readField(source: string | null, translation: string | null): SiteContentEntryFieldValue {
  const text = source ?? "";
  const translated = translation?.trim() ? translation : null;
  return translated !== null
    ? { text: translated, source: text, translated: true }
    : { text, source: text, translated: false };
}

function readVersionTerms(meta: unknown): SiteContentEntryVersionTerms {
  const record = toPhiRecord(meta) ?? {};
  const sourceLocale = typeof record.sourceLocale === "string" ? record.sourceLocale.trim() : "";
  return {
    sourceLocale: sourceLocale || null,
    // Absent means yes, which is the default the Markdown Widget already states for its own switch.
    translate: record.translate !== false,
  };
}

/**
 * What a tag is written as, in one place: trimmed and lower-cased.
 *
 * Its address is derived from this (`slugifySiteContentTerm`), so two spellings of one word are one term
 * with one translation to pay for. Lower case rather than title case because a tag is a key here as much
 * as a label, and the label a reader sees is its translation anyway.
 */
export function normalizePhiContentEntryTag(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/*
 * The link is kept under `linkTarget`, the one name a stored target answers to (REFERENCES.md): the
 * reference index and every reader find it by that name, and nothing else in `meta` is mistaken for one.
 * Tags are not here: they are terms (`site-content-terms.ts`).
 */
function buildEntryMeta(input: Pick<SiteContentEntryInput, "link">) {
  return { linkTarget: readPhiLinkTarget(input.link) };
}

function normalizeEntryTags(tags: readonly string[] | undefined) {
  return [...new Set((tags ?? []).map(normalizePhiContentEntryTag).filter(Boolean))];
}

/**
 * The roles that may be named as an entry's author: whoever may write entries (CONTENT.md). Admin is
 * named because it is a role a membership carries like any other, not because it passes every check.
 */
const ENTRY_AUTHOR_ROLE_FLAGS = PhiBaseRole.Admin | PhiBaseRole.Developer | PhiBaseRole.Author | PhiBaseRole.Publisher;

/**
 * An entry's terms, as one JSON array per entry: category first, then the tags in the order they were
 * given. One lateral read per entry rather than a second query, because every reader of an entry wants
 * them and a second round trip is paid on every page.
 */
const ENTRY_TERMS_JOIN = `LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object('vocabulary', link.vocabulary, 'slug', term.slug, 'label', term.label)
                       ORDER BY link.vocabulary DESC, link.sort_order ASC, term.id ASC) AS terms
       FROM phis.site_content_term_links link
       JOIN phis.site_content_terms term ON term.id = link.term_id
       WHERE link.content_id = c.id
     ) entry_terms ON TRUE`;

/**
 * The author as a reader sees them: the name the person is shown under and a picture that is already
 * public. The avatar's own delivery policy decides, not this read -- an Asset that is not Public and ready
 * is no picture here, so a byline can never be the way a private file leaves its Space.
 */
const ENTRY_AUTHOR_JOIN = `LEFT JOIN phis.user_profiles author_profile ON author_profile.user_id = c.author_user_id
     LEFT JOIN phis.user_site_avatars author_avatar
       ON author_avatar.user_id = c.author_user_id AND author_avatar.site_id = c.site_id
     LEFT JOIN phis.media_assets author_asset
       ON author_asset.id = author_avatar.asset_id
      AND author_asset.site_id = c.site_id
      AND author_asset.lifecycle_status = ${PhiMediaLifecycleStatus.Ready}
      AND author_asset.delivery_policy = ${PhiMediaDeliveryPolicy.Public}`;

type EntryTermsColumn = Array<{ vocabulary: number; slug: string; label: string }> | null;

function readEntryTerms(terms: EntryTermsColumn) {
  const list = Array.isArray(terms) ? terms : [];
  const category = list.find((term) => term.vocabulary === SITE_CONTENT_VOCABULARY_CATEGORY) ?? null;
  return {
    category: category ? { slug: category.slug, label: category.label } : null,
    tags: list
      .filter((term) => term.vocabulary === SITE_CONTENT_VOCABULARY_TAG)
      .map((term) => ({ slug: term.slug, label: term.label })),
  };
}

/** An entry is read on Public pages, so a Page target that names no Area is a Public Page. */
const ENTRY_LINK_AREA_ID = resolvePhisCmsAreaMask("public");

/** The words of one version, joined three times over: title, subtitle and body, with their translations. */
function entryTextJoins(versionColumn: string, localeParam: string) {
  return `LEFT JOIN phis.site_content_versions v ON v.id = c.${versionColumn}
     LEFT JOIN phis.site_content_version_text xt ON xt.version_id = v.id AND xt.field_name = 'title'
     LEFT JOIN phis.tr_site_msg mt ON mt.id = xt.msg_id
     LEFT JOIN phis.tr_site_lang tt ON tt.msg_id = mt.id AND tt.locale = ${localeParam}
     LEFT JOIN phis.site_content_version_text xs ON xs.version_id = v.id AND xs.field_name = 'subtitle'
     LEFT JOIN phis.tr_site_msg ms ON ms.id = xs.msg_id
     LEFT JOIN phis.tr_site_lang ts ON ts.msg_id = ms.id AND ts.locale = ${localeParam}
     LEFT JOIN phis.site_content_version_text xc ON xc.version_id = v.id AND xc.field_name = 'content'
     LEFT JOIN phis.tr_site_msg mc ON mc.id = xc.msg_id
     LEFT JOIN phis.tr_site_lang tc ON tc.msg_id = mc.id AND tc.locale = ${localeParam}`;
}

type PublishedEntryRow = {
  id: number;
  slug: string;
  status: number;
  published_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  meta: { linkTarget?: unknown } | null;
  version_meta: unknown;
  terms: EntryTermsColumn;
  author_name: string | null;
  author_asset_id: number | null;
  author_asset_delivery_revision: number | null;
  author_asset_variant_version: number | null;
  author_asset_content_type: string | null;
  title_source: string | null;
  title_translation: string | null;
  subtitle_source: string | null;
  subtitle_translation: string | null;
  content_source: string | null;
  content_translation: string | null;
};

/**
 * The published entries of a kind as one statement, narrowed by what the caller adds.
 *
 * Every public read goes through here -- the list, one entry by its address, the entries related to one --
 * so what "published" means is written once: published, already due, not yet expired.
 */
async function queryPublishedEntries(input: {
  kind: SiteContentEntryKind;
  siteId: number;
  locale: string;
  /** Extra conditions on `c`, with their parameters numbered from `$5`. */
  where?: string;
  /** Extra joins, before the conditions; may read `$5` onwards like `where`. */
  joins?: string;
  orderBy?: string;
  params?: readonly unknown[];
  limit?: number;
}) {
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0)) {
    throw new Error("A published entry read: limit must be a positive integer.");
  }
  const params = [
    input.siteId,
    input.locale,
    SITE_CONTENT_ENTRY_KINDS[input.kind].type,
    SITE_CONTENT_STATUS_PUBLISHED,
    ...(input.params ?? []),
  ];
  const limitClause = input.limit === undefined ? "" : `LIMIT $${params.push(input.limit)}`;
  const { rows } = await getPool().query<PublishedEntryRow>(
    `SELECT
       c.id,
       c.slug,
       c.status,
       c.published_at,
       c.expires_at,
       c.created_at,
       c.updated_at,
       c.meta,
       v.meta AS version_meta,
       mt.msg AS title_source,
       tt.translation AS title_translation,
       ms.msg AS subtitle_source,
       ts.translation AS subtitle_translation,
       mc.msg AS content_source,
       tc.translation AS content_translation,
       entry_terms.terms,
       ${userDisplayNameSql("author_profile")} AS author_name,
       author_asset.id AS author_asset_id,
       author_asset.delivery_revision AS author_asset_delivery_revision,
       author_asset.variant_version AS author_asset_variant_version,
       author_asset.content_type AS author_asset_content_type
     FROM phis.site_content c
     ${entryTextJoins("published_version_id", "$2")}
     ${ENTRY_TERMS_JOIN}
     ${ENTRY_AUTHOR_JOIN}
     ${input.joins ?? ""}
     WHERE c.site_id = $1
       AND c.type = $3
       AND c.status = $4
       AND (c.published_at IS NULL OR c.published_at <= NOW())
       AND (c.expires_at IS NULL OR c.expires_at > NOW())
       ${input.where ? `AND ${input.where}` : ""}
     ORDER BY ${input.orderBy ? `${input.orderBy}, ` : ""}COALESCE(c.published_at, c.created_at) DESC, c.sort_order ASC, c.id DESC
     ${limitClause}`,
    params,
  );

  return rows.map((row) => ({
    contentId: row.id,
    id: row.slug || String(row.id),
    slug: row.slug,
    created: toIsoDate(row.published_at) ?? toIsoDate(row.created_at) ?? new Date().toISOString(),
    outdated: toIsoDate(row.expires_at),
    title: readField(row.title_source, row.title_translation),
    subtitle: readField(row.subtitle_source, row.subtitle_translation),
    content: readField(row.content_source, row.content_translation),
    link: readPhiLinkTarget(row.meta?.linkTarget),
    ...readEntryTerms(row.terms),
    author: row.author_name
      ? {
        name: row.author_name,
        avatar: row.author_asset_id !== null
          ? {
            assetId: row.author_asset_id,
            deliveryRevision: row.author_asset_delivery_revision ?? 1,
            variantVersion: row.author_asset_variant_version,
            contentType: row.author_asset_content_type ?? "",
          }
          : null,
      } satisfies SiteContentEntryAuthor
      : null,
    ...readVersionTerms(row.version_meta),
  }));
}

export type SiteContentPublishedEntry = Awaited<ReturnType<typeof queryPublishedEntries>>[number];

/**
 * The published entries of a kind, newest first, cut at `limit` where the caller states one.
 *
 * The cut belongs here and not at the caller: everything after this read -- translating title, subtitle
 * and terms for the reader's language -- is paid per entry, and a Widget that shows ten should not have
 * the whole history translated to find them.
 */
export async function listPublishedSiteContentEntries(
  kind: SiteContentEntryKind,
  siteId: number,
  locale: string,
  options: { limit?: number; categories?: SiteContentEntryCategoryFilter } = {},
) {
  const filter = options.categories;
  if (!filter || (filter.categoryIds.length === 0 && !filter.uncategorized)) {
    return queryPublishedEntries({ kind, siteId, locale, limit: options.limit });
  }
  /*
   * Filtered in the read, before the cut: a list of ten whose newest entries are in other categories
   * still shows ten, and only those ten are translated.
   */
  return queryPublishedEntries({
    kind,
    siteId,
    locale,
    where: `(EXISTS (
         SELECT 1 FROM phis.site_content_term_links link
         WHERE link.content_id = c.id AND link.vocabulary = ${SITE_CONTENT_VOCABULARY_CATEGORY} AND link.term_id = ANY($5::int[])
       ) OR ($6::boolean AND NOT EXISTS (
         SELECT 1 FROM phis.site_content_term_links link
         WHERE link.content_id = c.id AND link.vocabulary = ${SITE_CONTENT_VOCABULARY_CATEGORY}
       )))`,
    params: [filter.categoryIds, filter.uncategorized],
    limit: options.limit,
  });
}

/**
 * Which categories a list shows: the entries filed under any of `categoryIds`, and with `uncategorized`
 * those filed under none. Neither is no filter at all.
 */
export type SiteContentEntryCategoryFilter = {
  categoryIds: number[];
  uncategorized: boolean;
};

/** The one published entry at an address -- a detail Page's question -- or `null`. */
export async function readPublishedSiteContentEntry(
  kind: SiteContentEntryKind,
  siteId: number,
  locale: string,
  slug: string,
) {
  const [entry] = await queryPublishedEntries({ kind, siteId, locale, where: "c.slug = $5", params: [slug], limit: 1 });
  return entry ?? null;
}

/**
 * The published entries closest to one, for a "more like this" list under it.
 *
 * Closeness is what the two have in common: the same category counts two, every shared tag one, and the
 * newest wins among equals -- so an entry with nothing in common with any other still gets the latest ones
 * rather than an empty list. The entry itself is never among them.
 */
export async function listRelatedSiteContentEntries(
  kind: SiteContentEntryKind,
  siteId: number,
  locale: string,
  options: { contentId: number; limit: number },
) {
  return queryPublishedEntries({
    kind,
    siteId,
    locale,
    joins: `LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(CASE WHEN mine.vocabulary = ${SITE_CONTENT_VOCABULARY_CATEGORY} THEN 2 ELSE 1 END), 0) AS score
       FROM phis.site_content_term_links theirs
       JOIN phis.site_content_term_links mine ON mine.term_id = theirs.term_id AND mine.content_id = $5
       WHERE theirs.content_id = c.id
     ) closeness ON TRUE`,
    where: "c.id <> $5",
    orderBy: "closeness.score DESC",
    params: [options.contentId],
    limit: options.limit,
  });
}

type EntryRowOutcome =
  | { ok: true; contentId: number; slug: string }
  | { ok: false; reason: "missing" | "slug_taken" }
  | { ok: false; reason: "conflict"; currentVersionId: number | null };

async function createOrUpdateEntryRow(db: DbQueryable, input: SiteContentEntryInput): Promise<EntryRowOutcome> {
  const type = SITE_CONTENT_ENTRY_KINDS[input.kind].type;
  const meta = JSON.stringify(buildEntryMeta(input));
  const slug = normalizeOptionalText(input.slug);

  if (input.contentId) {
    const { rows: current } = await db.query<{ current_version_id: number | null }>(
      `SELECT current_version_id FROM phis.site_content
       WHERE site_id = $1 AND id = $2 AND type = $3
       FOR UPDATE`,
      [input.siteId, input.contentId, type],
    );
    if (!current[0]) {
      return { ok: false, reason: "missing" };
    }
    // Every write builds on the version it read; one that does not is refused before it writes anything.
    if ((input.baseVersionId ?? null) !== current[0].current_version_id) {
      return { ok: false, reason: "conflict", currentVersionId: current[0].current_version_id };
    }
    // `status` and the three publication columns are absent on purpose: a save is not a publish.
    const { rows } = await db.query<{ id: number; slug: string }>(
      `UPDATE phis.site_content
       SET slug = COALESCE($3, slug),
           sort_order = $4,
           meta = $5::jsonb,
           updated_at = NOW()
       WHERE site_id = $1
         AND id = $2
         AND type = $6
       RETURNING id, slug`,
      [input.siteId, input.contentId, slug, input.sortOrder ?? 0, meta, type],
    );
    const row = rows[0];
    return row ? { ok: true, contentId: row.id, slug: row.slug } : { ok: false, reason: "missing" };
  }

  if (!slug) {
    throw new Error(`slug must not be empty for a new ${input.kind} entry.`);
  }

  /*
   * `DO NOTHING`: an entry's slug is authored and is its public address, so a second entry claiming it is
   * a mistake to report, not an edit to perform silently.
   *
   * The writer of a new entry is its author until a Publisher says otherwise (CONTENT.md, Curation) -- read
   * through the membership, because a writer who is no member of this Site (an operator) can be no byline.
   */
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO phis.site_content (site_id, type, slug, status, sort_order, meta, author_user_id)
     VALUES (
       $1, $2, $3, $4, $5, $6::jsonb,
       (SELECT m.user_id FROM phis.user_site_memberships m WHERE m.site_id = $1 AND m.user_id = $7)
     )
     ON CONFLICT (site_id, type, slug) DO NOTHING
     RETURNING id`,
    [input.siteId, type, slug, SITE_CONTENT_STATUS_DRAFT, input.sortOrder ?? 0, meta, input.createdByUserId ?? null],
  );
  const contentId = rows[0]?.id;
  return contentId ? { ok: true, contentId, slug } : { ok: false, reason: "slug_taken" };
}

/**
 * Writes one entry's words as a new version and points the draft at it.
 *
 * Every save is a version: the row keeps its history and a publish is then a choice of which version the
 * public sees. A save of an entry that exists names the version it read, and one that does not build on
 * the current version is refused with `conflict` (CONTENT.md, Concurrent writers).
 */
export async function saveSiteContentEntryDraft(input: SiteContentEntryInput): Promise<SiteContentEntryWriteOutcome> {
  if (!Number.isInteger(input.siteId) || input.siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }
  const contexts = SITE_CONTENT_ENTRY_KINDS[input.kind].contexts;
  const title = normalizeRequiredText(input.title, "title");
  const content = normalizeRequiredText(input.content, "content");
  const subtitle = normalizeOptionalText(input.subtitle);

  return withTransaction(async (client) => {
    const row = await createOrUpdateEntryRow(client, input);
    if (!row.ok) {
      return row;
    }

    /*
     * The version's `meta` carries how its words are to be read, and nothing else: `link` and `tags` stay
     * on the content row. These two belong to the words rather than to the entry -- a later version may be
     * written in another language -- and a save states the whole entry, so both are written every time.
     */
    const versionId = await insertSiteContentVersion(client, {
      contentId: row.contentId,
      meta: {
        sourceLocale: normalizeOptionalText(input.sourceLocale),
        translate: input.translate !== false,
      },
      createdByUserId: input.createdByUserId ?? null,
    });
    await upsertSiteContentTextField(client, {
      siteId: input.siteId,
      ctx: contexts.title,
      versionId,
      fieldName: "title",
      value: title,
    });
    // A new version starts without text rows, so a subtitle that was cleared is simply absent from it.
    if (subtitle) {
      await upsertSiteContentTextField(client, {
        siteId: input.siteId,
        ctx: contexts.subtitle,
        versionId,
        fieldName: "subtitle",
        value: subtitle,
      });
    }
    await upsertSiteContentTextField(client, {
      siteId: input.siteId,
      ctx: contexts.content,
      versionId,
      fieldName: "content",
      value: content,
    });
    await setSiteContentCurrentVersion(client, { contentId: row.contentId, versionId });
    // The tags are the entry's, like the link: stated whole by every save.
    await replaceSiteContentEntryTags(client, {
      siteId: input.siteId,
      type: SITE_CONTENT_ENTRY_KINDS[input.kind].type,
      contentId: row.contentId,
      tags: normalizeEntryTags(input.tags),
    });
    // The link lives on the row, so its reference set is the entry's whole set, replaced with every save.
    await replaceSiteCmsReferencesWithDb(client, {
      siteId: input.siteId,
      sourceKind: PhiCmsReferenceSourceKind.Content,
      sourceScopeId: row.contentId,
      sourceRevisionId: versionId,
      references: collectSiteCmsReferences({ linkTarget: input.link ?? null }, { targetAreaId: ENTRY_LINK_AREA_ID }),
    });

    return { ok: true, contentId: row.contentId, versionId, slug: row.slug };
  });
}

/**
 * Publishes a named version and states the terms: from when the entry is answered, and until when.
 *
 * The Publisher names the version they looked at -- normally the submitted one -- so an Author saving while
 * the Publisher reads cannot slip an unread version live. Publishing clears the submission.
 * `published_at` keeps an existing date when the caller names none, so a correction to a published entry
 * does not move it back to the top of the list. `expires_at` is taken as given, including `null`, because
 * a publish states the whole term rather than patching part of it.
 */
export async function publishSiteContentEntry(input: {
  kind: SiteContentEntryKind;
  siteId: number;
  contentId: number;
  versionId: number;
  publishedAt: string | null;
  expiresAt: string | null;
}): Promise<SiteContentEntryPublication | "missing" | "version_mismatch"> {
  const type = SITE_CONTENT_ENTRY_KINDS[input.kind].type;
  const { rows } = await getPool().query<{
    id: number;
    status: number;
    published_version_id: number;
    published_at: string | null;
    expires_at: string | null;
  }>(
    `UPDATE phis.site_content c
     SET status = $3,
         published_version_id = $7,
         submitted_version_id = NULL,
         published_at = COALESCE($4::timestamptz, published_at, NOW()),
         expires_at = $5::timestamptz,
         updated_at = NOW()
     WHERE c.site_id = $1
       AND c.id = $2
       AND c.type = $6
       AND EXISTS (SELECT 1 FROM phis.site_content_versions v WHERE v.id = $7 AND v.content_id = c.id)
     RETURNING c.id, c.status, c.published_version_id, c.published_at, c.expires_at`,
    [
      input.siteId,
      input.contentId,
      SITE_CONTENT_STATUS_PUBLISHED,
      input.publishedAt,
      input.expiresAt,
      type,
      input.versionId,
    ],
  );
  const row = rows[0];
  if (!row) {
    return (await siteContentEntryExists(input.kind, input.siteId, input.contentId)) ? "version_mismatch" : "missing";
  }
  return {
    contentId: row.id,
    status: row.status,
    publishedVersionId: row.published_version_id,
    publishedAt: toIsoDate(row.published_at),
    expiresAt: toIsoDate(row.expires_at),
  };
}

async function siteContentEntryExists(kind: SiteContentEntryKind, siteId: number, contentId: number) {
  const { rowCount } = await getPool().query(
    `SELECT 1 FROM phis.site_content WHERE site_id = $1 AND id = $2 AND type = $3`,
    [siteId, contentId, SITE_CONTENT_ENTRY_KINDS[kind].type],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Takes a published entry back out of the answer, and clears the terms it was published under.
 *
 * Idempotent: withdrawing a draft succeeds and changes nothing. The words are untouched -- what is
 * withdrawn is the publication, and the draft is still there to be published again.
 */
export async function withdrawSiteContentEntry(input: {
  kind: SiteContentEntryKind;
  siteId: number;
  contentId: number;
}): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE phis.site_content
     SET status = $3,
         published_version_id = NULL,
         published_at = NULL,
         expires_at = NULL,
         updated_at = NOW()
     WHERE site_id = $1
       AND id = $2
       AND type = $4`,
    [input.siteId, input.contentId, SITE_CONTENT_STATUS_DRAFT, SITE_CONTENT_ENTRY_KINDS[input.kind].type],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Removes an entry, its versions and its text rows through the cascade.
 *
 * A published entry is refused: taking something off a Site is the publishing authority's act, and a
 * delete that did it too would be that act reachable by whoever may only draft. The `status` predicate
 * sits in the `DELETE` itself, so a publish between the read and the write loses nothing.
 */
export async function deleteSiteContentEntry(input: {
  kind: SiteContentEntryKind;
  siteId: number;
  contentId: number;
}): Promise<"deleted" | "published" | "missing"> {
  const type = SITE_CONTENT_ENTRY_KINDS[input.kind].type;
  const pool = getPool();
  const { rows } = await pool.query<{ status: number }>(
    `SELECT status FROM phis.site_content WHERE site_id = $1 AND id = $2 AND type = $3 LIMIT 1`,
    [input.siteId, input.contentId, type],
  );
  const status = rows[0]?.status;
  if (status === undefined) {
    return "missing";
  }
  if (status === SITE_CONTENT_STATUS_PUBLISHED) {
    return "published";
  }
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM phis.site_content
       WHERE site_id = $1 AND id = $2 AND type = $3 AND status <> $4`,
      [input.siteId, input.contentId, type, SITE_CONTENT_STATUS_PUBLISHED],
    );
    if ((rowCount ?? 0) === 0) {
      return "published" as const;
    }
    await client.query(
      `DELETE FROM phis.site_cms_references
       WHERE site_id = $1 AND source_kind = $2 AND source_scope_id = $3`,
      [input.siteId, PhiCmsReferenceSourceKind.Content, input.contentId],
    );
    return "deleted" as const;
  });
}

/**
 * Puts the current version forward for publication. The writer names it, as with every write, so a
 * submission never covers a version its submitter has not seen; a later save leaves it where it is.
 */
export async function submitSiteContentEntry(input: {
  kind: SiteContentEntryKind;
  siteId: number;
  contentId: number;
  versionId: number;
}): Promise<"submitted" | "missing" | "version_mismatch"> {
  const { rowCount } = await getPool().query(
    `UPDATE phis.site_content
     SET submitted_version_id = $3,
         updated_at = NOW()
     WHERE site_id = $1 AND id = $2 AND type = $4 AND current_version_id = $3`,
    [input.siteId, input.contentId, input.versionId, SITE_CONTENT_ENTRY_KINDS[input.kind].type],
  );
  if ((rowCount ?? 0) > 0) return "submitted";
  return (await siteContentEntryExists(input.kind, input.siteId, input.contentId)) ? "version_mismatch" : "missing";
}

/** Withdraws a submission without publishing; idempotent. */
export async function withdrawSiteContentEntrySubmission(input: {
  kind: SiteContentEntryKind;
  siteId: number;
  contentId: number;
}): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE phis.site_content
     SET submitted_version_id = NULL,
         updated_at = NOW()
     WHERE site_id = $1 AND id = $2 AND type = $3`,
    [input.siteId, input.contentId, SITE_CONTENT_ENTRY_KINDS[input.kind].type],
  );
  return (rowCount ?? 0) > 0;
}

type EditorEntryRow = {
  id: number;
  slug: string;
  status: number;
  sort_order: number;
  published_at: string | null;
  expires_at: string | null;
  updated_at: string | null;
  current_version_id: number | null;
  published_version_id: number | null;
  submitted_version_id: number | null;
  meta: { linkTarget?: unknown } | null;
  version_meta: unknown;
  title: string | null;
  subtitle: string | null;
  content: string | null;
  author_user_id: number | null;
  author: string | null;
  terms: EntryTermsColumn;
  category_id: number | null;
};

/**
 * The editor's list: every entry of the kind, in the words of its draft.
 *
 * It joins `current_version_id` rather than `published_version_id`, because what an editor edits is the
 * draft; and it filters neither by status nor by date, because a schedule that cannot be seen before it
 * arrives cannot be corrected.
 */
export async function listSiteContentEntriesForEditor(input: {
  kind: SiteContentEntryKind;
  siteId: number;
  locale: string;
  page: number;
  pageSize: number;
  search?: string | null;
  status?: number | null;
}): Promise<{ rows: SiteContentEntryEditorRecord[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.trunc(input.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Math.trunc(input.pageSize) || 25));
  const search = input.search?.trim() ?? "";
  const status = Number.isInteger(input.status) ? input.status : null;
  const { rows } = await getPool().query<EditorEntryRow & { total_count: string }>(
    `SELECT
       COUNT(*) OVER () AS total_count,
       c.id,
       c.slug,
       c.status,
       c.sort_order,
       c.published_at,
       c.expires_at,
       c.updated_at,
       c.current_version_id,
       c.published_version_id,
       c.submitted_version_id,
       c.meta,
       v.meta AS version_meta,
       COALESCE(tt.translation, mt.msg) AS title,
       COALESCE(ts.translation, ms.msg) AS subtitle,
       COALESCE(tc.translation, mc.msg) AS content,
       c.author_user_id,
       -- Administration names a person without a name by their address, which a reader never sees.
       COALESCE(${userDisplayNameSql("author_profile")}, author_account.email_normalized) AS author,
       entry_terms.terms,
       category_link.term_id AS category_id
     FROM phis.site_content c
     ${entryTextJoins("current_version_id", "$2")}
     ${ENTRY_TERMS_JOIN}
     LEFT JOIN phis.user_profiles author_profile ON author_profile.user_id = c.author_user_id
     LEFT JOIN phis.user_account_directory author_account ON author_account.id = c.author_user_id
     LEFT JOIN phis.site_content_term_links category_link
       ON category_link.content_id = c.id AND category_link.vocabulary = ${SITE_CONTENT_VOCABULARY_CATEGORY}
     WHERE c.site_id = $1
       AND c.type = $3
       AND ($4::smallint IS NULL OR c.status = $4)
       -- The slug and the words as they were written: an editor searches for what they typed.
       AND ($5::text = '' OR c.slug ILIKE '%' || $5 || '%' OR mt.msg ILIKE '%' || $5 || '%')
     ORDER BY COALESCE(c.published_at, c.created_at) DESC, c.sort_order ASC, c.id DESC
     LIMIT $6
     OFFSET $7`,
    [
      input.siteId,
      input.locale,
      SITE_CONTENT_ENTRY_KINDS[input.kind].type,
      status,
      search,
      pageSize,
      (page - 1) * pageSize,
    ],
  );

  const records = rows.map((row) => {
    const terms = readEntryTerms(row.terms);
    return {
    contentId: row.id,
    slug: row.slug,
    status: row.status,
    sortOrder: row.sort_order,
    title: row.title ?? "",
    subtitle: row.subtitle ?? "",
    content: row.content ?? "",
    link: readPhiLinkTarget(row.meta?.linkTarget),
    tags: terms.tags.map((tag) => tag.label),
    publishedAt: toIsoDate(row.published_at),
    expiresAt: toIsoDate(row.expires_at),
    updatedAt: toIsoDate(row.updated_at),
    authorUserId: row.author_user_id,
    author: row.author,
    categoryId: row.category_id,
    category: terms.category?.label ?? null,
    hasUnpublishedChanges: row.published_version_id !== row.current_version_id,
    versionId: row.current_version_id,
    publishedVersionId: row.published_version_id,
    submittedVersionId: row.submitted_version_id,
    ...readVersionTerms(row.version_meta),
    };
  });

  return { rows: records, total: Number(rows[0]?.total_count ?? 0), page, pageSize };
}

/** A person who may be named as an entry's author, as the curation offer names them. */
export type SiteContentEntryAuthorCandidate = {
  userId: number;
  name: string;
};

/**
 * Who may be named as an entry's author on this Site: the enabled members whose core roles let them
 * write entries. Named as administration names people, an address where there is no name.
 */
export async function listSiteContentEntryAuthorCandidates(siteId: number): Promise<SiteContentEntryAuthorCandidate[]> {
  const { rows } = await getPool().query<{ user_id: number; name: string }>(
    `SELECT m.user_id,
            COALESCE(${userDisplayNameSql("profile")}, account.email_normalized, 'User #' || m.user_id::text) AS name
     FROM phis.user_site_memberships m
     JOIN phis.user_site_role_claims claim
       ON claim.user_id = m.user_id AND claim.site_id = m.site_id AND claim.provider_id = $2
     LEFT JOIN phis.user_profiles profile ON profile.user_id = m.user_id
     LEFT JOIN phis.user_account_directory account ON account.id = m.user_id
     WHERE m.site_id = $1
       AND (m.user_site_flags & ${USER_SITE_FLAG_DISABLED}) = 0
       AND (claim.role_flags & $3) <> 0
     ORDER BY LOWER(COALESCE(${userDisplayNameSql("profile")}, account.email_normalized, '')), m.user_id`,
    [siteId, PHI_CORE_ROLE_PROVIDER_ID, ENTRY_AUTHOR_ROLE_FLAGS],
  );
  return rows.map((row) => ({ userId: row.user_id, name: row.name }));
}

export type SiteContentEntryCuration = {
  contentId: number;
  authorUserId: number | null;
  categoryId: number | null;
};

/**
 * Names an entry's author and files it under a category -- the Publisher's half of an entry that is not
 * about when it is seen (CONTENT.md, Curation).
 *
 * On the entry rather than on a version, like its link and tags, so it is seen at once and not with the
 * next publish: an attribution is not a word of the text. A field left `undefined` is left as it is;
 * `null` clears it. An author who may not write entries here, or a category that is not one of this
 * kind's, is refused and nothing is written.
 */
export async function curateSiteContentEntry(input: {
  kind: SiteContentEntryKind;
  siteId: number;
  contentId: number;
  authorUserId?: number | null;
  categoryId?: number | null;
}): Promise<SiteContentEntryCuration | "missing" | "author_not_eligible" | "category_missing"> {
  const type = SITE_CONTENT_ENTRY_KINDS[input.kind].type;
  return withTransaction(async (client) => {
    const { rows: current } = await client.query<{ author_user_id: number | null }>(
      `SELECT author_user_id FROM phis.site_content
       WHERE site_id = $1 AND id = $2 AND type = $3
       FOR UPDATE`,
      [input.siteId, input.contentId, type],
    );
    if (!current[0]) {
      return "missing" as const;
    }

    if (input.authorUserId !== undefined && input.authorUserId !== null) {
      const { rowCount } = await client.query(
        `SELECT 1
         FROM phis.user_site_memberships m
         JOIN phis.user_site_role_claims claim
           ON claim.user_id = m.user_id AND claim.site_id = m.site_id AND claim.provider_id = $3
         WHERE m.site_id = $1 AND m.user_id = $2
           AND (m.user_site_flags & ${USER_SITE_FLAG_DISABLED}) = 0
           AND (claim.role_flags & $4) <> 0`,
        [input.siteId, input.authorUserId, PHI_CORE_ROLE_PROVIDER_ID, ENTRY_AUTHOR_ROLE_FLAGS],
      );
      if ((rowCount ?? 0) === 0) {
        return "author_not_eligible" as const;
      }
    }
    if (input.authorUserId !== undefined) {
      await client.query(
        `UPDATE phis.site_content SET author_user_id = $3, updated_at = NOW() WHERE site_id = $1 AND id = $2`,
        [input.siteId, input.contentId, input.authorUserId],
      );
    }
    if (input.categoryId !== undefined) {
      const outcome = await setSiteContentEntryCategory(client, {
        siteId: input.siteId,
        type,
        contentId: input.contentId,
        categoryId: input.categoryId,
      });
      if (outcome === "category_missing") {
        // Nothing of this curation may stand when part of it is refused.
        throw new CurationRefused("category_missing");
      }
    }

    const { rows } = await client.query<{ author_user_id: number | null; category_id: number | null }>(
      `SELECT c.author_user_id, link.term_id AS category_id
       FROM phis.site_content c
       LEFT JOIN phis.site_content_term_links link
         ON link.content_id = c.id AND link.vocabulary = ${SITE_CONTENT_VOCABULARY_CATEGORY}
       WHERE c.id = $1`,
      [input.contentId],
    );
    return {
      contentId: input.contentId,
      authorUserId: rows[0]?.author_user_id ?? null,
      categoryId: rows[0]?.category_id ?? null,
    };
  }).catch((error: unknown) => {
    if (error instanceof CurationRefused) {
      return error.reason;
    }
    throw error;
  });
}

class CurationRefused extends Error {
  constructor(readonly reason: "category_missing") {
    super(reason);
  }
}
