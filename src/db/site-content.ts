import "server-only";

import type { PoolClient } from "pg";

import { getPool, withTransaction } from "@/lib/db";
import {
  PhiCmsReferenceSourceKind,
} from "@/db/site-cms-references";
import { ensureSiteMessageId } from "@/db/translations";
import { sanitizePhiPersistedHtml } from "@/lib/html";
import { toPhiRecord } from "@/lib/helpers/record";

type SiteNewsRow = {
  id: number;
  slug: string;
  status: number;
  published_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  meta: { link?: string | null; tags?: string[] | null } | null;
  version_meta: unknown;
  title_source: string | null;
  title_translation: string | null;
  subtitle_source: string | null;
  subtitle_translation: string | null;
  content_source: string | null;
  content_translation: string | null;
};

type DbQueryable = Pick<PoolClient, "query">;

export const SITE_CONTENT_TYPE_NEWS = 0;
export const SITE_CONTENT_TYPE_PAGE = 1;
export const SITE_CONTENT_TYPE_LEGAL = 2;
export const SITE_CONTENT_TYPE_SNIPPET = 3;
export const SITE_CONTENT_TYPE_ASSET = 4;
export const SITE_CONTENT_TYPE_TEXT = 5;
export const SITE_CONTENT_TYPE_HTML = 6;
export const SITE_CONTENT_TYPE_MARKDOWN = 7;
export const SITE_CONTENT_STATUS_DRAFT = 0;
export const SITE_CONTENT_STATUS_PUBLISHED = 1;

export type SiteContentAssetInput = {
  siteId: number;
  contentId?: number | null;
  slug: string;
  assetId: number;
  title?: string | null;
  altText?: string | null;
  caption?: string | null;
  sortOrder?: number;
  status?: number;
  meta?: Record<string, unknown>;
  createdByUserId?: number | null;
};

export type SiteContentTextInput = {
  siteId: number;
  contentId?: number | null;
  slug?: string | null;
  text: string;
  sortOrder?: number;
  status?: number;
  meta?: Record<string, unknown>;
  createdByUserId?: number | null;
};

export type SiteContentHtmlInput = {
  siteId: number;
  contentId?: number | null;
  slug?: string | null;
  html: string;
  sortOrder?: number;
  status?: number;
  meta?: Record<string, unknown>;
  createdByUserId?: number | null;
};

export type SiteContentMarkdownInput = {
  siteId: number;
  contentId?: number | null;
  slug?: string | null;
  markdown: string;
  sortOrder?: number;
  status?: number;
  meta?: Record<string, unknown>;
  createdByUserId?: number | null;
};

export type SiteContentWriteResult = {
  contentId: number;
  versionId: number;
  slug: string;
};

export type SiteResolvedContentTextField = {
  msgId: number;
  source: string;
  value: string;
};

export type SiteResolvedContentRecord = {
  id: number;
  type: number;
  slug: string;
  /** The version the revision pins; `assetId`, `meta` and `textFields` are that version's. */
  versionId: number;
  assetId: number | null;
  status: number;
  meta: Record<string, unknown>;
  textFields: Record<string, SiteResolvedContentTextField>;
};

function toIsoDate(value: string | null) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function normalizeOptionalText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeRequiredText(value: string | null | undefined, fieldName: string) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  return normalized;
}

function normalizeHtmlContent(value: string | null | undefined) {
  if (typeof value !== "string") {
    throw new Error("html must be a string.");
  }

  // `site_content(type=html)` is the declared internal content channel from `REFERENCES.md`, so it
  // keeps canonical `phis:page/` and `phis:asset/` URIs instead of stripping them as unknown schemes.
  return sanitizePhiPersistedHtml(value, { allowInternalReferences: true });
}

function normalizeMarkdownContent(value: string | null | undefined) {
  if (typeof value !== "string") {
    throw new Error("markdown must be a string.");
  }

  return value.trim();
}

async function upsertSiteContentTextField(
  db: DbQueryable,
  input: {
    siteId: number;
    /**
     * The translation context the message is kept under, which is part of its identity
     * (`UNIQUE (site_id, msg_hash, ctx)`) and is handed to the provider as a hint.
     *
     * Empty for the widget-owned types: their text is whatever a Widget was given, and a context would
     * split one message into one row per Widget kind without telling a translator anything. News states
     * one, because "news entry title" is a real hint and because it is how those rows are found again.
     */
    ctx: string;
    versionId: number;
    fieldName: string;
    value: string;
  },
) {
  // On the caller's transaction: through the pool, the message row outlived a rolled-back save, and ten
  // saves at once each held a client while waiting for a second one the pool no longer had.
  const msgId = await ensureSiteMessageId(
    input.siteId,
    input.value,
    input.ctx,
    db,
  );

  await db.query(
    `INSERT INTO phis.site_content_version_text (version_id, field_name, msg_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (version_id, field_name)
     DO UPDATE SET msg_id = EXCLUDED.msg_id`,
    [input.versionId, input.fieldName, msgId],
  );
}

async function insertSiteContentVersion(
  db: DbQueryable,
  input: {
    contentId: number;
    assetId?: number | null;
    meta: Record<string, unknown>;
    createdByUserId?: number | null;
  },
) {
  const versionRow = await db.query<{ id: number }>(
    `INSERT INTO phis.site_content_versions (
       content_id,
       version_no,
       asset_id,
       meta,
       created_by_user_id
     )
     VALUES (
       $1,
       COALESCE((SELECT MAX(version_no) + 1 FROM phis.site_content_versions WHERE content_id = $1), 1),
       $2,
       $3::jsonb,
       $4
     )
     RETURNING id`,
    [
      input.contentId,
      input.assetId ?? null,
      JSON.stringify(input.meta ?? {}),
      input.createdByUserId ?? null,
    ],
  );

  const versionId = versionRow.rows[0]?.id;
  if (!versionId) {
    throw new Error("Failed to persist site content version.");
  }

  return versionId;
}

/**
 * Moves the content row's `current_version_id` to the version a save just wrote.
 *
 * Nothing else: what a page shows is the version its revision pins, so a draft save leaves the
 * published revision's content alone. `published_version_id` and `published_at` belong to `news`.
 */
async function setSiteContentCurrentVersion(
  db: DbQueryable,
  input: {
    contentId: number;
    versionId: number;
  },
) {
  await db.query(
    `UPDATE phis.site_content
     SET current_version_id = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [input.contentId, input.versionId],
  );
}

async function resolveExistingSiteContentByType(
  db: DbQueryable,
  input: {
    siteId: number;
    contentId: number;
    type: number;
    typeLabel: string;
  },
) {
  const { rows } = await db.query<{ id: number; slug: string; type: number }>(
    `SELECT id, slug, type
     FROM phis.site_content
     WHERE site_id = $1
       AND id = $2
     LIMIT 1`,
    [input.siteId, input.contentId],
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`Site content ${input.contentId} does not exist on site ${input.siteId}.`);
  }
  if (row.type !== input.type) {
    throw new Error(`Site content ${input.contentId} is not type=${input.typeLabel}.`);
  }

  return row;
}

async function createOrUpdateSiteContentRow(
  db: DbQueryable,
  input: {
    siteId: number;
    contentId?: number | null;
    slug?: string | null;
    sortOrder?: number;
    status?: number;
    meta?: Record<string, unknown>;
    contentType: number;
    typeLabel: string;
  },
) {
  if (input.contentId) {
    const existing = await resolveExistingSiteContentByType(db, {
      siteId: input.siteId,
      contentId: input.contentId,
      type: input.contentType,
      typeLabel: input.typeLabel,
    });

    await db.query(
      `UPDATE phis.site_content
       SET status = $3,
           sort_order = $4,
           meta = $5::jsonb,
           updated_at = NOW()
       WHERE site_id = $1
         AND id = $2`,
      [
        input.siteId,
        input.contentId,
        input.status ?? SITE_CONTENT_STATUS_PUBLISHED,
        input.sortOrder ?? 0,
        JSON.stringify(input.meta ?? {}),
      ],
    );

    return {
      contentId: existing.id,
      slug: existing.slug,
    };
  }

  const slug = input.slug?.trim();
  if (!slug) {
    throw new Error(`slug must not be empty for new ${input.typeLabel} content.`);
  }

  const contentRow = await db.query<{ id: number }>(
    `INSERT INTO phis.site_content (
       site_id,
       type,
       slug,
       status,
       sort_order,
       meta
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (site_id, type, slug)
     DO UPDATE SET
       status = EXCLUDED.status,
       sort_order = EXCLUDED.sort_order,
       meta = EXCLUDED.meta,
       updated_at = NOW()
     RETURNING id`,
    [
      input.siteId,
      input.contentType,
      slug,
      input.status ?? SITE_CONTENT_STATUS_PUBLISHED,
      input.sortOrder ?? 0,
      JSON.stringify(input.meta ?? {}),
    ],
  );

  const contentId = contentRow.rows[0]?.id;
  if (!contentId) {
    throw new Error(`Failed to persist site ${input.typeLabel} content.`);
  }

  return { contentId, slug };
}

export async function upsertSiteContentAssetWithClient(
  client: PoolClient,
  input: SiteContentAssetInput,
): Promise<SiteContentWriteResult> {
  if (!Number.isInteger(input.siteId) || input.siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }
  if (!Number.isInteger(input.assetId) || input.assetId <= 0) {
    throw new Error("assetId must be a positive integer.");
  }

  const slug = input.slug.trim();
  if (!slug && !input.contentId) {
    throw new Error("slug must not be empty.");
  }

  const { contentId, slug: storedSlug } = await createOrUpdateSiteContentRow(client, {
    ...input,
    slug,
    contentType: SITE_CONTENT_TYPE_ASSET,
    typeLabel: "asset",
  });
  const versionId = await insertSiteContentVersion(client, {
    contentId,
    assetId: input.assetId,
    meta: input.meta ?? {},
    createdByUserId: input.createdByUserId ?? null,
  });

  const title = normalizeOptionalText(input.title);
  const altText = normalizeOptionalText(input.altText);
  const caption = normalizeOptionalText(input.caption);

  if (title) {
    await upsertSiteContentTextField(client, {
      siteId: input.siteId,
      ctx: "",
      versionId,
      fieldName: "title",
      value: title,
    });
  }
  if (altText) {
    await upsertSiteContentTextField(client, {
      siteId: input.siteId,
      ctx: "",
      versionId,
      fieldName: "alt",
      value: altText,
    });
  }
  if (caption) {
    await upsertSiteContentTextField(client, {
      siteId: input.siteId,
      ctx: "",
      versionId,
      fieldName: "caption",
      value: caption,
    });
  }

  await setSiteContentCurrentVersion(client, { contentId, versionId });

  return { contentId, versionId, slug: storedSlug };
}

export async function upsertSiteContentTextWithClient(
  client: PoolClient,
  input: SiteContentTextInput,
): Promise<SiteContentWriteResult> {
  if (!Number.isInteger(input.siteId) || input.siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }

  const text = normalizeRequiredText(input.text, "text");
  const { contentId, slug } = await createOrUpdateSiteContentRow(client, {
    ...input,
    contentType: SITE_CONTENT_TYPE_TEXT,
    typeLabel: "text",
  });

  const versionId = await insertSiteContentVersion(client, {
    contentId,
    meta: input.meta ?? {},
    createdByUserId: input.createdByUserId ?? null,
  });

  await upsertSiteContentTextField(client, {
    siteId: input.siteId,
    ctx: "",
    versionId,
    fieldName: "text",
    value: text,
  });

  await setSiteContentCurrentVersion(client, { contentId, versionId });

  return { contentId, versionId, slug };
}

export async function upsertSiteContentHtmlWithClient(
  client: PoolClient,
  input: SiteContentHtmlInput,
): Promise<SiteContentWriteResult & { html: string }> {
  if (!Number.isInteger(input.siteId) || input.siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }

  const html = normalizeHtmlContent(input.html);
  const { contentId, slug } = await createOrUpdateSiteContentRow(client, {
    ...input,
    contentType: SITE_CONTENT_TYPE_HTML,
    typeLabel: "html",
    meta: {
      format: "html",
      ...(input.meta ?? {}),
    },
  });

  const meta = {
    format: "html",
    ...(input.meta ?? {}),
  };
  const versionId = await insertSiteContentVersion(client, {
    contentId,
    meta,
    createdByUserId: input.createdByUserId ?? null,
  });

  await upsertSiteContentTextField(client, {
    siteId: input.siteId,
    ctx: "",
    versionId,
    fieldName: "html",
    value: html,
  });

  await setSiteContentCurrentVersion(client, { contentId, versionId });

  return { contentId, versionId, slug, html };
}

export async function upsertSiteContentMarkdownWithClient(
  client: PoolClient,
  input: SiteContentMarkdownInput,
): Promise<SiteContentWriteResult & { markdown: string }> {
  if (!Number.isInteger(input.siteId) || input.siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }

  const markdown = normalizeMarkdownContent(input.markdown);
  const meta = {
    format: "markdown",
    ...(input.meta ?? {}),
  };
  const { contentId, slug } = await createOrUpdateSiteContentRow(client, {
    ...input,
    contentType: SITE_CONTENT_TYPE_MARKDOWN,
    typeLabel: "markdown",
    meta,
  });

  const versionId = await insertSiteContentVersion(client, {
    contentId,
    meta,
    createdByUserId: input.createdByUserId ?? null,
  });

  await upsertSiteContentTextField(client, {
    siteId: input.siteId,
    ctx: "",
    versionId,
    fieldName: "markdown",
    value: markdown,
  });

  await setSiteContentCurrentVersion(client, { contentId, versionId });

  return { contentId, versionId, slug, markdown };
}

/**
 * Resolves the content versions a revision tree pins, keyed by version id.
 *
 * The version is the unit a revision shows: its asset, meta and text fields. The content row only
 * contributes identity (type, slug, status), so two revisions pinning different versions of one row
 * each see their own.
 */
export async function getResolvedSiteContentByVersionIds(
  siteId: number,
  versionIds: number[],
  locale?: string | null,
) {
  const uniqueVersionIds = Array.from(
    new Set(versionIds.filter((versionId) => Number.isInteger(versionId) && versionId > 0)),
  );

  if (!Number.isInteger(siteId) || siteId <= 0 || uniqueVersionIds.length === 0) {
    return new Map<number, SiteResolvedContentRecord>();
  }

  const normalizedLocale = typeof locale === "string" && locale.trim() ? locale.trim() : null;
  const translationSelect =
    normalizedLocale == null ? "NULL::text AS translated_msg" : "lang.translation AS translated_msg";
  const translationJoin =
    normalizedLocale == null
      ? ""
      : "\n     LEFT JOIN phis.tr_site_lang lang ON lang.msg_id = xt.msg_id AND lang.locale = $3";
  const params =
    normalizedLocale == null
      ? [siteId, uniqueVersionIds]
      : [siteId, uniqueVersionIds, normalizedLocale];

  const { rows } = await getPool().query<{
    content_id: number;
    version_id: number;
    type: number;
    slug: string;
    asset_id: number | null;
    status: number;
    meta: Record<string, unknown> | null;
    field_name: string | null;
    msg_id: number | null;
    source_msg: string | null;
    translated_msg: string | null;
  }>(
    `SELECT c.id AS content_id,
            v.id AS version_id,
            c.type,
            c.slug,
            v.asset_id,
            c.status,
            v.meta,
            xt.field_name,
            xt.msg_id,
            msg.msg AS source_msg,
            ${translationSelect}
     FROM phis.site_content_versions v
     JOIN phis.site_content c ON c.id = v.content_id
     LEFT JOIN phis.site_content_version_text xt ON xt.version_id = v.id
     LEFT JOIN phis.tr_site_msg msg ON msg.id = xt.msg_id${translationJoin}
     WHERE c.site_id = $1
       AND v.id = ANY($2::int[])
     ORDER BY v.id ASC, xt.field_name ASC`,
    params,
  );

  const resolvedByVersionId = new Map<number, SiteResolvedContentRecord>();

  for (const row of rows) {
    const existing =
      resolvedByVersionId.get(row.version_id) ??
      ({
        id: row.content_id,
        type: row.type,
        slug: row.slug,
        versionId: row.version_id,
        assetId: row.asset_id,
        status: row.status,
        meta: toPhiRecord(row.meta),
        textFields: {},
      } satisfies SiteResolvedContentRecord);

    if (row.field_name && row.msg_id && row.source_msg) {
      existing.textFields[row.field_name] = {
        msgId: row.msg_id,
        source: row.source_msg,
        value: row.translated_msg ?? row.source_msg,
      };
    }

    resolvedByVersionId.set(row.version_id, existing);
  }

  return resolvedByVersionId;
}

export async function listPublishedNews(siteId: number, locale: string) {
  const pool = getPool();
  const { rows } = await pool.query<SiteNewsRow>(
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
       tc.translation AS content_translation
     FROM phis.site_content c
     LEFT JOIN phis.site_content_versions v ON v.id = c.published_version_id
     LEFT JOIN phis.site_content_version_text xt ON xt.version_id = v.id AND xt.field_name = 'title'
     LEFT JOIN phis.tr_site_msg mt ON mt.id = xt.msg_id
     LEFT JOIN phis.tr_site_lang tt ON tt.msg_id = mt.id AND tt.locale = $2
     LEFT JOIN phis.site_content_version_text xs ON xs.version_id = v.id AND xs.field_name = 'subtitle'
     LEFT JOIN phis.tr_site_msg ms ON ms.id = xs.msg_id
     LEFT JOIN phis.tr_site_lang ts ON ts.msg_id = ms.id AND ts.locale = $2
     LEFT JOIN phis.site_content_version_text xc ON xc.version_id = v.id AND xc.field_name = 'content'
     LEFT JOIN phis.tr_site_msg mc ON mc.id = xc.msg_id
     LEFT JOIN phis.tr_site_lang tc ON tc.msg_id = mc.id AND tc.locale = $2
     WHERE c.site_id = $1
       AND c.type = ${SITE_CONTENT_TYPE_NEWS}
       AND c.status = ${SITE_CONTENT_STATUS_PUBLISHED}
       AND (c.published_at IS NULL OR c.published_at <= NOW())
       AND (c.expires_at IS NULL OR c.expires_at > NOW())
     ORDER BY COALESCE(c.published_at, c.created_at) DESC, c.sort_order ASC, c.id DESC`,
    [siteId, locale],
  );

  return rows.map((row) => ({
    id: row.slug || String(row.id),
    slug: row.slug,
    created: toIsoDate(row.published_at) ?? toIsoDate(row.created_at) ?? new Date().toISOString(),
    outdated: toIsoDate(row.expires_at),
    title: readSiteNewsField(row.title_source, row.title_translation),
    subtitle: readSiteNewsField(row.subtitle_source, row.subtitle_translation),
    content: readSiteNewsField(row.content_source, row.content_translation),
    link: row.meta?.link ?? null,
    tags: Array.isArray(row.meta?.tags)
      ? row.meta.tags.filter((item: unknown): item is string => typeof item === "string")
      : [],
    ...readSiteNewsVersionTerms(row.version_meta),
  }));
}

/*
 * The News write path, which is two authorities over two sets of columns.
 *
 * A save writes words: one new version, its text fields, and `current_version_id` pointing at it. A
 * publish writes when the entry is seen: `status`, `published_version_id`, `published_at` and
 * `expires_at`. They are separate functions because AUTHORIZATION.md gives them to separate roles --
 * `PHI_ACCESS_CONTENT_EDITING` drafts, `PHI_ACCESS_PUBLISHING` publishes -- and one statement covering
 * both sets of columns would be reachable by whoever may do the lesser of the two.
 *
 * What the public reads is `published_version_id`. An edit made after a publish is therefore written,
 * kept, and not seen until it is published in turn, which is the whole reason that column exists.
 */

/**
 * The translation context each News field is kept under.
 *
 * Natural language rather than a structural key, and deliberately **not per entry**. The context is part
 * of a message's identity, so `news:81:title` would give every entry its own row and pay for the same
 * sentence twice; a phrase shared by all titles keeps the dedupe and is, per `DB.md`, the better hint for
 * the provider. It is also what makes these rows findable in the translations editor, which lists contexts.
 *
 * The read path states the same values when it asks for a translation, so the cached answer lands on the
 * row the entry already points at rather than on a second one.
 */
export const PHI_NEWS_TRANSLATION_CONTEXTS = {
  title: "news entry title",
  subtitle: "news entry subtitle",
  content: "news entry body",
  /*
   * A tag is a word the entry carries, not a field of its version: it lives in the content row's `meta` as
   * a plain string and becomes a message the first time somebody reads it in another language. The
   * translator is content-addressed, so nothing has to register it beforehand -- and the same tag in two
   * entries is one message, paid for once.
   */
  tag: "news tag",
} as const;

export type SiteContentNewsInput = {
  siteId: number;
  contentId?: number | null;
  slug?: string | null;
  title: string;
  subtitle?: string | null;
  content: string;
  link?: string | null;
  tags?: readonly string[];
  sortOrder?: number;
  /**
   * The language these words are written in, or null for the Site's canonical one.
   *
   * Declared, never guessed. It is what lets an author write in their own language: a read in another
   * one then goes the external route -- translated into the canonical language first, the original kept
   * as the answer for its own language -- which is the path external Markdown has always taken
   * (`src/lib/translations.ts`, `translateExternalSiteBatch`).
   */
  sourceLocale?: string | null;
  /** Whether a reader in another language may be served a translation at all. Absent means yes. */
  translate?: boolean;
  createdByUserId?: number | null;
};

/** What a version records about its own words, beside the words themselves. */
export type SiteNewsVersionTerms = {
  sourceLocale: string | null;
  translate: boolean;
};

/**
 * One field of a News entry as the store answers it.
 *
 * `translated` is the part the read path needs and the old `COALESCE` hid: a field that fell back to its
 * source is a field nobody has translated yet, and only the reader knows whether that is worth a
 * provider call.
 */
export type SiteNewsFieldValue = {
  /** What a reader in the asked-for language gets: a translation where one exists, the source otherwise. */
  text: string;
  /** The words as they were written, whatever language that is. */
  source: string;
  translated: boolean;
};

export type SiteNewsWriteOutcome =
  | { ok: true; contentId: number; versionId: number; slug: string }
  | { ok: false; reason: "missing" | "slug_taken" };

export type SiteNewsPublication = {
  contentId: number;
  status: number;
  publishedAt: string | null;
  expiresAt: string | null;
};

export type SiteNewsEditorRecord = SiteNewsVersionTerms & {
  contentId: number;
  slug: string;
  status: number;
  sortOrder: number;
  title: string;
  subtitle: string;
  content: string;
  link: string | null;
  tags: string[];
  publishedAt: string | null;
  expiresAt: string | null;
  updatedAt: string | null;
  hasUnpublishedChanges: boolean;
};

type SiteNewsEditorRow = {
  id: number;
  slug: string;
  status: number;
  sort_order: number;
  published_at: string | null;
  expires_at: string | null;
  updated_at: string | null;
  has_unpublished_changes: boolean;
  meta: { link?: string | null; tags?: string[] | null } | null;
  version_meta: unknown;
  title: string | null;
  subtitle: string | null;
  content: string | null;
};

function readSiteNewsField(source: string | null, translation: string | null): SiteNewsFieldValue {
  const text = source ?? "";
  const translated = translation?.trim() ? translation : null;
  return translated !== null
    ? { text: translated, source: text, translated: true }
    : { text, source: text, translated: false };
}

function readSiteNewsVersionTerms(meta: unknown): SiteNewsVersionTerms {
  const record = toPhiRecord(meta) ?? {};
  const sourceLocale = typeof record.sourceLocale === "string" ? record.sourceLocale.trim() : "";
  return {
    sourceLocale: sourceLocale || null,
    // Absent means yes, which is the default the Markdown Widget already states for its own switch.
    translate: record.translate !== false,
  };
}

/**
 * What a tag is, in one place: trimmed and lower-cased.
 *
 * The string is the tag's identity -- there is no row and no id behind it -- so two spellings would be two
 * tags, each with its own translation to pay for. Normalising on the way in is what keeps "Release" and
 * "release" one thing. Lower case rather than title case because a tag is a key here as much as a label,
 * and the label a reader sees is its translation anyway.
 */
export function normalizePhiNewsTag(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function buildSiteNewsMeta(input: Pick<SiteContentNewsInput, "link" | "tags">) {
  const tags = [...new Set((input.tags ?? []).map(normalizePhiNewsTag).filter(Boolean))];
  return { link: normalizeOptionalText(input.link), tags };
}

async function createOrUpdateSiteNewsRow(
  db: DbQueryable,
  input: SiteContentNewsInput,
): Promise<{ ok: true; contentId: number; slug: string } | { ok: false; reason: "missing" | "slug_taken" }> {
  const meta = JSON.stringify(buildSiteNewsMeta(input));
  const slug = normalizeOptionalText(input.slug);

  if (input.contentId) {
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
      [input.siteId, input.contentId, slug, input.sortOrder ?? 0, meta, SITE_CONTENT_TYPE_NEWS],
    );

    const row = rows[0];
    return row ? { ok: true, contentId: row.id, slug: row.slug } : { ok: false, reason: "missing" };
  }

  if (!slug) {
    throw new Error("slug must not be empty for new news content.");
  }

  /*
   * `DO NOTHING` rather than the `DO UPDATE` the widget-owned content types use. Their slug is generated
   * and a collision means the same row; a News slug is authored and is the entry's public address, so a
   * second entry claiming it is a mistake to report, not an edit to perform silently.
   */
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO phis.site_content (site_id, type, slug, status, sort_order, meta)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (site_id, type, slug) DO NOTHING
     RETURNING id`,
    [input.siteId, SITE_CONTENT_TYPE_NEWS, slug, SITE_CONTENT_STATUS_DRAFT, input.sortOrder ?? 0, meta],
  );

  const contentId = rows[0]?.id;
  return contentId ? { ok: true, contentId, slug } : { ok: false, reason: "slug_taken" };
}

/**
 * Writes one News entry's words as a new version and points the draft at it.
 *
 * Every save is a version, as it is for every other content type: the row keeps its history and a
 * publish is then a choice of which version the public sees.
 */
export async function saveSiteContentNewsDraft(
  input: SiteContentNewsInput,
): Promise<SiteNewsWriteOutcome> {
  if (!Number.isInteger(input.siteId) || input.siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }

  const title = normalizeRequiredText(input.title, "title");
  const content = normalizeRequiredText(input.content, "content");
  const subtitle = normalizeOptionalText(input.subtitle);

  return withTransaction(async (client) => {
    const row = await createOrUpdateSiteNewsRow(client, input);
    if (!row.ok) {
      return row;
    }

    /*
     * The version's `meta` carries how its words are to be read, and nothing else: `link` and `tags` stay
     * on the content row, where a second copy would be a second answer to the same question. These two
     * belong to the words rather than to the entry -- a later version may be written in another language
     * -- and a save states the whole entry, so both are written every time.
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
      ctx: PHI_NEWS_TRANSLATION_CONTEXTS.title,
      versionId,
      fieldName: "title",
      value: title,
    });
    // A new version starts without text rows, so a subtitle that was cleared is simply absent from it.
    if (subtitle) {
      await upsertSiteContentTextField(client, {
        siteId: input.siteId,
        ctx: PHI_NEWS_TRANSLATION_CONTEXTS.subtitle,
        versionId,
        fieldName: "subtitle",
        value: subtitle,
      });
    }
    await upsertSiteContentTextField(client, {
      siteId: input.siteId,
      ctx: PHI_NEWS_TRANSLATION_CONTEXTS.content,
      versionId,
      fieldName: "content",
      value: content,
    });

    await setSiteContentCurrentVersion(client, { contentId: row.contentId, versionId });

    return { ok: true, contentId: row.contentId, versionId, slug: row.slug };
  });
}

/**
 * Publishes the draft version and states the terms: from when the entry is answered, and until when.
 *
 * `published_at` keeps an existing date when the caller names none, so a correction to a published entry
 * does not move it back to the top of the list. `expires_at` is taken as given, including `null`, because
 * a publish states the whole term rather than patching part of it.
 */
export async function publishSiteContentNews(input: {
  siteId: number;
  contentId: number;
  publishedAt: string | null;
  expiresAt: string | null;
}): Promise<SiteNewsPublication | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: number;
    status: number;
    published_at: string | null;
    expires_at: string | null;
  }>(
    `UPDATE phis.site_content
     SET status = $3,
         published_version_id = current_version_id,
         published_at = COALESCE($4::timestamptz, published_at, NOW()),
         expires_at = $5::timestamptz,
         updated_at = NOW()
     WHERE site_id = $1
       AND id = $2
       AND type = $6
       AND current_version_id IS NOT NULL
     RETURNING id, status, published_at, expires_at`,
    [
      input.siteId,
      input.contentId,
      SITE_CONTENT_STATUS_PUBLISHED,
      input.publishedAt,
      input.expiresAt,
      SITE_CONTENT_TYPE_NEWS,
    ],
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    contentId: row.id,
    status: row.status,
    publishedAt: toIsoDate(row.published_at),
    expiresAt: toIsoDate(row.expires_at),
  };
}

/**
 * Takes a published entry back out of the answer, and clears the terms it was published under.
 *
 * Idempotent: withdrawing a draft succeeds and changes nothing. The words are untouched -- what is
 * withdrawn is the publication, and the draft is still there to be published again.
 */
export async function withdrawSiteContentNews(input: {
  siteId: number;
  contentId: number;
}): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE phis.site_content
     SET status = $3,
         published_version_id = NULL,
         published_at = NULL,
         expires_at = NULL,
         updated_at = NOW()
     WHERE site_id = $1
       AND id = $2
       AND type = $4`,
    [input.siteId, input.contentId, SITE_CONTENT_STATUS_DRAFT, SITE_CONTENT_TYPE_NEWS],
  );

  return (rowCount ?? 0) > 0;
}

/**
 * Removes a News entry, its versions and its text rows through the cascade.
 *
 * A published entry is refused: taking something off a Site is the publishing authority's act, and a
 * delete that did it too would be that act reachable by whoever may only draft. The `status` predicate
 * sits in the `DELETE` itself, so a publish between the read and the write loses nothing.
 */
export async function deleteSiteContentNews(input: {
  siteId: number;
  contentId: number;
}): Promise<"deleted" | "published" | "missing"> {
  const pool = getPool();
  const { rows } = await pool.query<{ status: number }>(
    `SELECT status
     FROM phis.site_content
     WHERE site_id = $1 AND id = $2 AND type = $3
     LIMIT 1`,
    [input.siteId, input.contentId, SITE_CONTENT_TYPE_NEWS],
  );

  const status = rows[0]?.status;
  if (status === undefined) {
    return "missing";
  }
  if (status === SITE_CONTENT_STATUS_PUBLISHED) {
    return "published";
  }

  const { rowCount } = await pool.query(
    `DELETE FROM phis.site_content
     WHERE site_id = $1
       AND id = $2
       AND type = $3
       AND status <> $4`,
    [input.siteId, input.contentId, SITE_CONTENT_TYPE_NEWS, SITE_CONTENT_STATUS_PUBLISHED],
  );

  return (rowCount ?? 0) > 0 ? "deleted" : "published";
}

/**
 * The editor's list: every entry of the Site, in the words of its draft.
 *
 * Two things separate it from `listPublishedNews`. It joins `current_version_id` rather than
 * `published_version_id`, because what an editor edits is the draft; and it filters neither by status nor
 * by date, because a schedule that cannot be seen before it arrives cannot be corrected.
 */
export async function listSiteContentNewsForEditor(
  siteId: number,
  locale: string,
): Promise<SiteNewsEditorRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<SiteNewsEditorRow>(
    `SELECT
       c.id,
       c.slug,
       c.status,
       c.sort_order,
       c.published_at,
       c.expires_at,
       c.updated_at,
       (c.published_version_id IS DISTINCT FROM c.current_version_id) AS has_unpublished_changes,
       c.meta,
       v.meta AS version_meta,
       COALESCE(tt.translation, mt.msg) AS title,
       COALESCE(ts.translation, ms.msg) AS subtitle,
       COALESCE(tc.translation, mc.msg) AS content
     FROM phis.site_content c
     LEFT JOIN phis.site_content_versions v ON v.id = c.current_version_id
     LEFT JOIN phis.site_content_version_text xt ON xt.version_id = v.id AND xt.field_name = 'title'
     LEFT JOIN phis.tr_site_msg mt ON mt.id = xt.msg_id
     LEFT JOIN phis.tr_site_lang tt ON tt.msg_id = mt.id AND tt.locale = $2
     LEFT JOIN phis.site_content_version_text xs ON xs.version_id = v.id AND xs.field_name = 'subtitle'
     LEFT JOIN phis.tr_site_msg ms ON ms.id = xs.msg_id
     LEFT JOIN phis.tr_site_lang ts ON ts.msg_id = ms.id AND ts.locale = $2
     LEFT JOIN phis.site_content_version_text xc ON xc.version_id = v.id AND xc.field_name = 'content'
     LEFT JOIN phis.tr_site_msg mc ON mc.id = xc.msg_id
     LEFT JOIN phis.tr_site_lang tc ON tc.msg_id = mc.id AND tc.locale = $2
     WHERE c.site_id = $1
       AND c.type = $3
     ORDER BY COALESCE(c.published_at, c.created_at) DESC, c.sort_order ASC, c.id DESC`,
    [siteId, locale, SITE_CONTENT_TYPE_NEWS],
  );

  return rows.map((row) => ({
    contentId: row.id,
    slug: row.slug,
    status: row.status,
    sortOrder: row.sort_order,
    title: row.title ?? "",
    subtitle: row.subtitle ?? "",
    content: row.content ?? "",
    link: row.meta?.link ?? null,
    tags: Array.isArray(row.meta?.tags)
      ? row.meta.tags.filter((item: unknown): item is string => typeof item === "string")
      : [],
    publishedAt: toIsoDate(row.published_at),
    expiresAt: toIsoDate(row.expires_at),
    updatedAt: toIsoDate(row.updated_at),
    hasUnpublishedChanges: row.has_unpublished_changes,
    ...readSiteNewsVersionTerms(row.version_meta),
  }));
}

/**
 * Extracts the widget-owned content ids referenced by one revision tree.
 *
 * Only `contentWidgets[*].contentId` participates: preset trees may ship local text without a backing
 * content row, and those simply yield no id here.
 */
export function collectRevisionContentIds(treeJson: unknown): number[] {
  const widgets = (treeJson as { contentWidgets?: unknown } | null)?.contentWidgets;
  if (!Array.isArray(widgets)) return [];
  const ids = new Set<number>();
  for (const widget of widgets) {
    const contentId = (widget as { contentId?: unknown } | null)?.contentId;
    if (typeof contentId === "number" && Number.isSafeInteger(contentId) && contentId > 0) {
      ids.add(contentId);
    }
  }
  return [...ids];
}

/**
 * Deletes widget-owned content rows that no revision of the Site references any more.
 *
 * Callers pass the candidate ids that just lost a referencing widget — a save's removal diff or a
 * deleted revision's tree. The statement itself re-checks every candidate against the
 * `contentWidgets[*].contentId` arrays of all page and area revisions of the Site, so a content row
 * survives as long as any historical revision could still be restored to it. Runs inside the caller's
 * transaction; the same-transaction revision write is therefore visible to the check. Content-source
 * rows in the reference index are retired for exactly the deleted ids.
 */
export async function deleteOrphanedSiteContentByIdsWithDb(
  db: DbQueryable,
  siteId: number,
  contentIds: readonly number[],
): Promise<number[]> {
  const candidates = [...new Set(contentIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (candidates.length === 0) return [];

  const { rows } = await db.query<{ id: number }>(
    `WITH deletable AS (
       SELECT c.id
       FROM phis.site_content c
       WHERE c.site_id = $1
         AND c.id = ANY($2::int[])
         AND c.type = ANY($3::smallint[])
         AND NOT EXISTS (
           SELECT 1
           FROM phis.site_page_revisions r
           JOIN phis.site_page_scopes s ON s.id = r.page_scope_id AND s.site_id = $1
           WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(r.tree_json->'contentWidgets', '[]'::jsonb)) w
             WHERE (w->>'contentId')::int = c.id
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM phis.site_area_revisions r
           JOIN phis.site_area_scopes s ON s.id = r.area_scope_id AND s.site_id = $1
           WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(r.tree_json->'contentWidgets', '[]'::jsonb)) w
             WHERE (w->>'contentId')::int = c.id
           )
         )
     )
     DELETE FROM phis.site_content c
     USING deletable d
     WHERE c.id = d.id
     RETURNING c.id`,
    [
      siteId,
      candidates,
      [SITE_CONTENT_TYPE_ASSET, SITE_CONTENT_TYPE_TEXT, SITE_CONTENT_TYPE_HTML, SITE_CONTENT_TYPE_MARKDOWN],
    ],
  );
  const deletedIds = rows.map((row) => row.id);
  if (deletedIds.length > 0) {
    await db.query(
      `DELETE FROM phis.site_cms_references
       WHERE site_id = $1 AND source_kind = $2 AND source_scope_id = ANY($3::int[])`,
      [siteId, PhiCmsReferenceSourceKind.Content, deletedIds],
    );
  }
  return deletedIds;
}
