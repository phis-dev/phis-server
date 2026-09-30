import "server-only";

import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";
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
  title: string | null;
  subtitle: string | null;
  content: string | null;
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
    contentTypeKey: string;
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
    "",
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
      contentTypeKey: "asset",
      versionId,
      fieldName: "title",
      value: title,
    });
  }
  if (altText) {
    await upsertSiteContentTextField(client, {
      siteId: input.siteId,
      contentTypeKey: "asset",
      versionId,
      fieldName: "alt",
      value: altText,
    });
  }
  if (caption) {
    await upsertSiteContentTextField(client, {
      siteId: input.siteId,
      contentTypeKey: "asset",
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
    contentTypeKey: "content",
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
    contentTypeKey: "html",
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
    contentTypeKey: "markdown",
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
       COALESCE(tt.translation, mt.msg) AS title,
       COALESCE(ts.translation, ms.msg) AS subtitle,
       COALESCE(tc.translation, mc.msg) AS content
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
    title: row.title ?? "",
    subtitle: row.subtitle ?? "",
    content: row.content ?? "",
    link: row.meta?.link ?? null,
    tags: Array.isArray(row.meta?.tags)
      ? row.meta.tags.filter((item: unknown): item is string => typeof item === "string")
      : [],
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
