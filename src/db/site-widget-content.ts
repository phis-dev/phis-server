import "server-only";

import type { PoolClient } from "pg";

import {
  insertSiteContentVersion,
  normalizeHtmlContent,
  normalizeMarkdownContent,
  normalizeOptionalText,
  setSiteContentCurrentVersion,
  upsertSiteContentTextField,
  SITE_CONTENT_STATUS_DRAFT,
  SITE_CONTENT_STATUS_PUBLISHED,
  SITE_CONTENT_TYPE_ASSET,
  SITE_CONTENT_TYPE_HTML,
  SITE_CONTENT_TYPE_MARKDOWN,
  SITE_CONTENT_TYPE_TEXT,
  type DbQueryable,
} from "@/db/site-content";
import {
  collectSiteCmsContentReferences,
  PhiCmsReferenceSourceKind,
  replaceSiteCmsReferencesWithDb,
} from "@/db/site-cms-references";
import { getPool, withTransaction } from "@/lib/db";
import { readPhiCmsInstanceIdDescriptor } from "@/lib/cms/instance-id";

/*
 * The content of Widgets, bound by instance and published apart from structure (CONTENT.md).
 *
 * A Widget names the config field that is its content through `contentBinding`; the row that answers
 * for it is the one whose `instance_id` is the Widget's id. Revision trees hold neither a content id nor
 * a version pin, so a structure reset, restore or publish leaves the binding where it is.
 */

export type SiteWidgetContentStorage = "text" | "html" | "markdown" | "asset";

export type SiteWidgetContentStage = "published" | "current";

const SITE_WIDGET_CONTENT_TYPE_BY_STORAGE = {
  text: SITE_CONTENT_TYPE_TEXT,
  html: SITE_CONTENT_TYPE_HTML,
  markdown: SITE_CONTENT_TYPE_MARKDOWN,
  asset: SITE_CONTENT_TYPE_ASSET,
} as const satisfies Record<SiteWidgetContentStorage, number>;

/** The text field a storage keeps its value under; an asset keeps it in `site_content_versions.asset_id`. */
const SITE_WIDGET_CONTENT_FIELD_BY_STORAGE = {
  text: "text",
  html: "html",
  markdown: "markdown",
  asset: null,
} as const satisfies Record<SiteWidgetContentStorage, string | null>;

export const SITE_WIDGET_CONTENT_TYPES: readonly number[] = Object.values(SITE_WIDGET_CONTENT_TYPE_BY_STORAGE);

export function isSiteWidgetContentStorage(value: unknown): value is SiteWidgetContentStorage {
  return typeof value === "string" && Object.hasOwn(SITE_WIDGET_CONTENT_TYPE_BY_STORAGE, value);
}

/**
 * A write that did not build on the row's current version: somebody else saved in between. Nothing was
 * written; the writer reloads and decides.
 */
export class SiteContentConflictError extends Error {
  readonly contentId: number;
  readonly currentVersionId: number | null;

  constructor(contentId: number, currentVersionId: number | null) {
    super(`Site content ${contentId} has moved on to version ${currentVersionId ?? "none"}.`);
    this.name = "SiteContentConflictError";
    this.contentId = contentId;
    this.currentVersionId = currentVersionId;
  }
}

/** A preset node is the Module's until a content write binds it; a draft node is the Site's from the start. */
export function isPresetWidgetInstance(instanceId: string) {
  return readPhiCmsInstanceIdDescriptor(instanceId)?.origin === "preset";
}

export type SiteWidgetContentRow = {
  id: number;
  instanceId: string;
  type: number;
  slug: string;
  currentVersionId: number | null;
  publishedVersionId: number | null;
  submittedVersionId: number | null;
};

type SiteWidgetContentRowSql = {
  id: number;
  instance_id: string;
  type: number;
  slug: string;
  current_version_id: number | null;
  published_version_id: number | null;
  submitted_version_id: number | null;
};

function mapRow(row: SiteWidgetContentRowSql): SiteWidgetContentRow {
  return {
    id: row.id,
    instanceId: row.instance_id,
    type: row.type,
    slug: row.slug,
    currentVersionId: row.current_version_id,
    publishedVersionId: row.published_version_id,
    submittedVersionId: row.submitted_version_id,
  };
}

/** The content rows bound to these Widget instances, keyed by instance id. */
export async function readSiteWidgetContentRowsWithDb(
  db: DbQueryable,
  siteId: number,
  instanceIds: readonly string[],
  options?: { forUpdate?: boolean },
): Promise<Map<string, SiteWidgetContentRow>> {
  const ids = [...new Set(instanceIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return new Map();
  const { rows } = await db.query<SiteWidgetContentRowSql>(
    `SELECT id, instance_id, type, slug, current_version_id, published_version_id, submitted_version_id
     FROM phis.site_content
     WHERE site_id = $1
       AND instance_id = ANY($2::varchar[])
     ORDER BY id ASC
     ${options?.forUpdate ? "FOR UPDATE" : ""}`,
    [siteId, ids],
  );
  return new Map(rows.map((row) => [row.instance_id, mapRow(row)]));
}

/** What one version holds for a storage: its source text, or its asset id. */
async function readSiteWidgetContentVersionValueWithDb(
  db: DbQueryable,
  versionId: number,
  storage: SiteWidgetContentStorage,
): Promise<string | number | null> {
  const field = SITE_WIDGET_CONTENT_FIELD_BY_STORAGE[storage];
  if (field == null) {
    const { rows } = await db.query<{ asset_id: number | null }>(
      `SELECT asset_id FROM phis.site_content_versions WHERE id = $1`,
      [versionId],
    );
    return rows[0]?.asset_id ?? null;
  }
  const { rows } = await db.query<{ msg: string }>(
    `SELECT msg.msg
     FROM phis.site_content_version_text xt
     JOIN phis.tr_site_msg msg ON msg.id = xt.msg_id
     WHERE xt.version_id = $1
       AND xt.field_name = $2`,
    [versionId, field],
  );
  return rows[0]?.msg ?? null;
}

function normalizeSiteWidgetContentValue(storage: SiteWidgetContentStorage, value: string | number) {
  switch (storage) {
    case "asset": {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error("An asset content value must be a positive asset id.");
      }
      return value;
    }
    case "html":
      return normalizeHtmlContent(String(value));
    case "markdown":
      return normalizeMarkdownContent(String(value));
    case "text": {
      const text = typeof value === "string" ? value.trim() : "";
      if (!text) {
        throw new Error("A text content value must not be empty.");
      }
      return text;
    }
  }
}

/**
 * Where a Widget's content is shown, as the last write that knew it said: a Page by path or by preset, or
 * an Area. It is what a Publisher's queue names, and nothing reads it to render -- the binding is the
 * instance id. A preset node bound through the Editor has no revision a query could find it in, so the
 * place is written down rather than searched for.
 */
export type SiteWidgetContentPlace =
  | { scope: "page"; area: string; path: string | null; ownerModuleId: string | null; presetKey: string | null }
  | { scope: "area"; area: string };

export type SiteWidgetContentWriteInput = {
  siteId: number;
  instanceId: string;
  storage: SiteWidgetContentStorage;
  value: string | number;
  /** The version the writer read; `null` for a Widget that had no content. */
  baseVersionId: number | null;
  /** The slug a new row is created under. */
  slug: string;
  /** The Area relative references in an HTML or Markdown body resolve against. */
  referenceAreaId: number;
  /** An asset version's words, copied from the media asset when the version is written. */
  asset?: { title: string | null; altText: string | null } | null;
  /** Where the Widget is shown; kept on the row for the Publisher's queue. */
  place?: SiteWidgetContentPlace | null;
  createdByUserId?: number | null;
};

export type SiteWidgetContentWriteResult = {
  contentId: number;
  /** The row's current version after the write -- the new one, or the one an unchanged write left. */
  versionId: number;
  written: boolean;
  /** The value as stored: HTML sanitised, Markdown and text trimmed. */
  value: string | number;
};

/**
 * Writes a Widget's content as a new version and points the draft at it (CONTENT.md, Concurrent writers).
 *
 * A value equal to the current version's writes nothing, and so does one equal to the version the writer
 * read: a writer who did not change what they read is not overwriting anybody. Anything else must build on
 * the current version, or is refused with `SiteContentConflictError` before anything is written.
 */
export async function writeSiteWidgetContentWithClient(
  client: PoolClient,
  input: SiteWidgetContentWriteInput,
): Promise<SiteWidgetContentWriteResult> {
  const type = SITE_WIDGET_CONTENT_TYPE_BY_STORAGE[input.storage];
  const value = normalizeSiteWidgetContentValue(input.storage, input.value);
  const existing = (await readSiteWidgetContentRowsWithDb(client, input.siteId, [input.instanceId], {
    forUpdate: true,
  })).get(input.instanceId);

  let contentId: number;
  if (existing) {
    if (existing.type !== type) {
      throw new Error(
        `Widget ${input.instanceId} is bound to content of type ${existing.type}, not ${input.storage}.`,
      );
    }
    contentId = existing.id;
    if (input.place) {
      await client.query(
        `UPDATE phis.site_content SET meta = meta || jsonb_build_object('place', $2::jsonb) WHERE id = $1`,
        [contentId, JSON.stringify(input.place)],
      );
    }
    const currentVersionId = existing.currentVersionId;
    if (currentVersionId != null) {
      const currentValue = await readSiteWidgetContentVersionValueWithDb(client, currentVersionId, input.storage);
      if (currentValue === value) {
        return { contentId, versionId: currentVersionId, written: false, value };
      }
      if (input.baseVersionId != null && input.baseVersionId !== currentVersionId) {
        const baseValue = await readSiteWidgetContentVersionValueWithDb(client, input.baseVersionId, input.storage);
        if (baseValue === value) {
          return { contentId, versionId: currentVersionId, written: false, value };
        }
      }
    }
    if (input.baseVersionId !== currentVersionId) {
      throw new SiteContentConflictError(contentId, currentVersionId);
    }
  } else {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO phis.site_content (site_id, type, slug, status, instance_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        input.siteId,
        type,
        input.slug,
        SITE_CONTENT_STATUS_DRAFT,
        input.instanceId,
        JSON.stringify({
          ...(input.storage === "asset" ? {} : { format: input.storage }),
          ...(input.place ? { place: input.place } : {}),
        }),
      ],
    );
    contentId = rows[0]!.id;
  }

  const versionId = await insertSiteContentVersion(client, {
    contentId,
    assetId: input.storage === "asset" ? (value as number) : null,
    meta: input.storage === "asset" ? {} : { format: input.storage },
    createdByUserId: input.createdByUserId ?? null,
  });
  const field = SITE_WIDGET_CONTENT_FIELD_BY_STORAGE[input.storage];
  if (field != null) {
    await upsertSiteContentTextField(client, {
      siteId: input.siteId,
      ctx: "",
      versionId,
      fieldName: field,
      value: value as string,
    });
    if (input.storage === "html" || input.storage === "markdown") {
      await replaceSiteCmsReferencesWithDb(client, {
        siteId: input.siteId,
        sourceKind: PhiCmsReferenceSourceKind.Content,
        sourceScopeId: contentId,
        sourceRevisionId: versionId,
        references: collectSiteCmsContentReferences(input.storage, value as string, {
          targetAreaId: input.referenceAreaId,
        }),
      });
    }
  } else {
    for (const [fieldName, text] of [
      ["title", normalizeOptionalText(input.asset?.title)],
      ["alt", normalizeOptionalText(input.asset?.altText)],
    ] as const) {
      if (text) {
        await upsertSiteContentTextField(client, { siteId: input.siteId, ctx: "", versionId, fieldName, value: text });
      }
    }
  }
  await setSiteContentCurrentVersion(client, { contentId, versionId });

  return { contentId, versionId, written: true, value };
}

/**
 * The version each bound Widget shows in a stage: the published one for the live Site, the current one for
 * everything that edits or previews. A row without a version in the stage is still reported, so a caller
 * can tell "bound, nothing published" from "not bound".
 */
export async function readSiteWidgetContentVersionsWithDb(
  db: DbQueryable,
  siteId: number,
  instanceIds: readonly string[],
  stage: SiteWidgetContentStage,
): Promise<Map<string, { row: SiteWidgetContentRow; versionId: number | null }>> {
  const rows = await readSiteWidgetContentRowsWithDb(db, siteId, instanceIds);
  return new Map([...rows].map(([instanceId, row]) => [
    instanceId,
    { row, versionId: stage === "published" ? row.publishedVersionId : row.currentVersionId },
  ]));
}

/**
 * The instance ids of the Widgets one revision tree places. Only these can be bound; the sweep below asks
 * which of them no revision places any more.
 */
export function collectRevisionWidgetInstanceIds(treeJson: unknown): string[] {
  const widgets = (treeJson as { contentWidgets?: unknown } | null)?.contentWidgets;
  if (!Array.isArray(widgets)) return [];
  const ids = new Set<string>();
  for (const widget of widgets) {
    const id = (widget as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return [...ids];
}

/**
 * Deletes the content of Site-created Widgets that no revision of the Site places any more
 * (CONTENT.md, Lifecycle).
 *
 * Callers pass the instance ids that just lost a revision -- a save's removal diff or a deleted revision's
 * tree. Preset nodes are skipped: their content outlives every revision, because resetting an override
 * removes structure and not the words written for the preset. Runs on the caller's transaction, so the
 * revision write it follows is visible to the check.
 */
export async function deleteOrphanedSiteWidgetContentWithDb(
  db: DbQueryable,
  siteId: number,
  instanceIds: readonly string[],
): Promise<number[]> {
  const candidates = [...new Set(instanceIds)].filter((id) => !isPresetWidgetInstance(id));
  if (candidates.length === 0) return [];

  const { rows } = await db.query<{ id: number }>(
    `WITH deletable AS (
       SELECT c.id
       FROM phis.site_content c
       WHERE c.site_id = $1
         AND c.instance_id = ANY($2::varchar[])
         AND NOT EXISTS (
           SELECT 1
           FROM phis.site_page_revisions r
           JOIN phis.site_page_scopes s ON s.id = r.page_scope_id AND s.site_id = $1
           WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(r.tree_json->'contentWidgets', '[]'::jsonb)) w
             WHERE w->>'id' = c.instance_id
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM phis.site_area_revisions r
           JOIN phis.site_area_scopes s ON s.id = r.area_scope_id AND s.site_id = $1
           WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements(COALESCE(r.tree_json->'contentWidgets', '[]'::jsonb)) w
             WHERE w->>'id' = c.instance_id
           )
         )
     )
     DELETE FROM phis.site_content c
     USING deletable d
     WHERE c.id = d.id
     RETURNING c.id`,
    [siteId, candidates],
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

export type SiteWidgetContentPublishOutcome =
  | { ok: true; contentId: number; publishedVersionId: number | null }
  | { ok: false; reason: "missing" | "version_mismatch" };

/**
 * Puts a named version of a Widget's content live and clears the submission (CONTENT.md, Submission).
 *
 * The Publisher names the version they looked at -- normally the submitted one -- rather than "whatever is
 * current", so an Author saving while the Publisher reads cannot slip an unread version live.
 */
export async function publishSiteWidgetContent(input: {
  siteId: number;
  contentId: number;
  versionId: number;
}): Promise<SiteWidgetContentPublishOutcome> {
  const { rows } = await getPool().query<{ id: number; published_version_id: number | null }>(
    `UPDATE phis.site_content c
     SET published_version_id = $3,
         status = $4,
         published_at = NOW(),
         submitted_version_id = NULL,
         updated_at = NOW()
     WHERE c.site_id = $1
       AND c.id = $2
       AND c.type = ANY($5::smallint[])
       AND EXISTS (SELECT 1 FROM phis.site_content_versions v WHERE v.id = $3 AND v.content_id = c.id)
     RETURNING c.id, c.published_version_id`,
    [input.siteId, input.contentId, input.versionId, SITE_CONTENT_STATUS_PUBLISHED, SITE_WIDGET_CONTENT_TYPES],
  );
  if (rows[0]) {
    return { ok: true, contentId: rows[0].id, publishedVersionId: rows[0].published_version_id };
  }
  return (await siteWidgetContentExists(input.siteId, input.contentId))
    ? { ok: false, reason: "version_mismatch" }
    : { ok: false, reason: "missing" };
}

/** Takes a Widget's content off the live Site; its versions stay, and so does any submission. */
export async function withdrawSiteWidgetContent(input: {
  siteId: number;
  contentId: number;
}): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE phis.site_content
     SET published_version_id = NULL,
         status = $3,
         published_at = NULL,
         updated_at = NOW()
     WHERE site_id = $1
       AND id = $2
       AND type = ANY($4::smallint[])`,
    [input.siteId, input.contentId, SITE_CONTENT_STATUS_DRAFT, SITE_WIDGET_CONTENT_TYPES],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Puts the current version forward for publication. The writer names it, as with every write, so a
 * submission never covers a version its submitter has not seen.
 */
export async function submitSiteWidgetContent(input: {
  siteId: number;
  contentId: number;
  versionId: number;
}): Promise<SiteWidgetContentPublishOutcome> {
  const { rows } = await getPool().query<{ id: number; published_version_id: number | null }>(
    `UPDATE phis.site_content
     SET submitted_version_id = $3,
         updated_at = NOW()
     WHERE site_id = $1
       AND id = $2
       AND type = ANY($4::smallint[])
       AND current_version_id = $3
     RETURNING id, published_version_id`,
    [input.siteId, input.contentId, input.versionId, SITE_WIDGET_CONTENT_TYPES],
  );
  if (rows[0]) {
    return { ok: true, contentId: rows[0].id, publishedVersionId: rows[0].published_version_id };
  }
  return (await siteWidgetContentExists(input.siteId, input.contentId))
    ? { ok: false, reason: "version_mismatch" }
    : { ok: false, reason: "missing" };
}

/** Withdraws a submission without publishing; idempotent. */
export async function withdrawSiteWidgetContentSubmission(input: {
  siteId: number;
  contentId: number;
}): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE phis.site_content
     SET submitted_version_id = NULL,
         updated_at = NOW()
     WHERE site_id = $1
       AND id = $2
       AND type = ANY($3::smallint[])`,
    [input.siteId, input.contentId, SITE_WIDGET_CONTENT_TYPES],
  );
  return (rowCount ?? 0) > 0;
}

async function siteWidgetContentExists(siteId: number, contentId: number) {
  const { rowCount } = await getPool().query(
    `SELECT 1 FROM phis.site_content WHERE site_id = $1 AND id = $2 AND type = ANY($3::smallint[])`,
    [siteId, contentId, SITE_WIDGET_CONTENT_TYPES],
  );
  return (rowCount ?? 0) > 0;
}

/** A content write through the editor: one Widget, its own transaction. */
export async function saveSiteWidgetContent(input: SiteWidgetContentWriteInput) {
  return withTransaction((client) => writeSiteWidgetContentWithClient(client, input));
}
