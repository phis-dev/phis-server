import "server-only";

import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";
import { ensureSiteMessageId } from "@/db/translations";
import { sanitizePhiPersistedHtml } from "@/lib/html";
import { toPhiRecord } from "@/lib/helpers/record";

export type DbQueryable = Pick<PoolClient, "query">;

export const SITE_CONTENT_TYPE_NEWS = 0;
export const SITE_CONTENT_TYPE_PAGE = 1;
export const SITE_CONTENT_TYPE_LEGAL = 2;
export const SITE_CONTENT_TYPE_SNIPPET = 3;
export const SITE_CONTENT_TYPE_ASSET = 4;
export const SITE_CONTENT_TYPE_TEXT = 5;
export const SITE_CONTENT_TYPE_HTML = 6;
export const SITE_CONTENT_TYPE_MARKDOWN = 7;
export const SITE_CONTENT_TYPE_BLOG = 8;
export const SITE_CONTENT_STATUS_DRAFT = 0;
export const SITE_CONTENT_STATUS_PUBLISHED = 1;

/**
 * The vocabularies an entry's terms belong to (CONTENT.md, Terms): words it is tagged with, and the
 * category it is filed under. One table holds both, so a later vocabulary is a value and not a schema.
 */
export const SITE_CONTENT_VOCABULARY_TAG = 1;
export const SITE_CONTENT_VOCABULARY_CATEGORY = 2;

export type SiteResolvedContentTextField = {
  msgId: number;
  source: string;
  value: string;
};

export type SiteResolvedContentRecord = {
  id: number;
  type: number;
  slug: string;
  /** The version read -- published or current, as the reader asked; `assetId`, `meta` and `textFields` are its. */
  versionId: number;
  assetId: number | null;
  status: number;
  meta: Record<string, unknown>;
  textFields: Record<string, SiteResolvedContentTextField>;
};

export function normalizeOptionalText(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeHtmlContent(value: string | null | undefined) {
  if (typeof value !== "string") {
    throw new Error("html must be a string.");
  }

  // `site_content(type=html)` is the declared internal content channel from `REFERENCES.md`, so it
  // keeps canonical `phis:page/` and `phis:asset/` URIs instead of stripping them as unknown schemes.
  return sanitizePhiPersistedHtml(value, { allowInternalReferences: true });
}

export function normalizeMarkdownContent(value: string | null | undefined) {
  if (typeof value !== "string") {
    throw new Error("markdown must be a string.");
  }

  return value.trim();
}

export async function upsertSiteContentTextField(
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

export async function insertSiteContentVersion(
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
 * Nothing else: what the live Site shows is `published_version_id`, which only a publish moves
 * (CONTENT.md).
 */
export async function setSiteContentCurrentVersion(
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

/**
 * Resolves content versions, keyed by version id.
 *
 * The version is the unit a reader shows: its asset, meta and text fields. The content row only
 * contributes identity (type, slug, status).
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
