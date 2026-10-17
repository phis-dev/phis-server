import "server-only";

import { getPool } from "@/lib/db";
import { resolvePhisCmsAreaKey } from "@/lib/constants/cms-areas";
import { SITE_CONTENT_ENTRY_KINDS, type SiteContentEntryKind } from "@/db/site-content-entries";
import { SITE_WIDGET_CONTENT_TYPES, type SiteWidgetContentPlace } from "@/db/site-widget-content";

/*
 * The Publisher's queue (CONTENT.md, Submission): everything that waits for somebody to put it live.
 *
 * Three kinds of thing wait. A Widget's content an Author submitted; a content type's entry an Author
 * submitted; and the structure of a Page or an Area a Builder saved as a Working Draft -- structure has no
 * submission, because a Builder's draft is the request. Drafts in progress -- content saved and not
 * submitted -- are not queued: they are visible to everybody who edits, and nobody asked for them yet.
 */

export type SiteReleasePerson = { userId: number; name: string | null; email: string | null };

export type SiteReleaseItem =
  | {
      kind: "content";
      contentId: number;
      instanceId: string;
      storage: "text" | "html" | "markdown" | "asset";
      submittedVersionId: number;
      currentVersionId: number | null;
      publishedVersionId: number | null;
      /** The submitted words, cut to a line; an asset answers its id. */
      preview: string | null;
      place: SiteWidgetContentPlace | null;
      writtenAt: string;
      writtenBy: SiteReleasePerson | null;
    }
  | {
      kind: "entry";
      entryKind: SiteContentEntryKind;
      contentId: number;
      slug: string;
      title: string | null;
      submittedVersionId: number;
      currentVersionId: number | null;
      publishedVersionId: number | null;
      writtenAt: string;
      writtenBy: SiteReleasePerson | null;
    }
  | {
      kind: "page";
      area: string;
      path: string | null;
      ownerModuleId: string | null;
      presetKey: string | null;
      revisionId: number;
      savedAt: string;
      savedBy: SiteReleasePerson | null;
    }
  | {
      kind: "area";
      area: string;
      /** Which of the Area's two Working Drafts: its structure, or its Module selection. */
      part: "structure" | "modules";
      revisionId: number;
      /** The Shell preset the Area stands on, which its publish names. */
      ownerModuleId: string | null;
      presetKey: string | null;
      savedAt: string;
      savedBy: SiteReleasePerson | null;
    };

const STORAGE_BY_TYPE = new Map<number, "text" | "html" | "markdown" | "asset">([
  [4, "asset"],
  [5, "text"],
  [6, "html"],
  [7, "markdown"],
]);

const ENTRY_KIND_BY_TYPE = new Map<number, SiteContentEntryKind>(
  (Object.entries(SITE_CONTENT_ENTRY_KINDS) as [SiteContentEntryKind, { type: number }][])
    .map(([kind, declaration]) => [declaration.type, kind]),
);

/** The most a queue answers; a Site with more waiting than this has a different problem. */
const SITE_RELEASES_LIMIT = 200;

function personSql(alias: string, idExpression: string) {
  return {
    columns: `${idExpression} AS ${alias}_user_id,
              NULLIF(TRIM(CONCAT_WS(' ', ${alias}_profile.first_name, ${alias}_profile.last_name)), '') AS ${alias}_user_name,
              ${alias}_directory.email_normalized AS ${alias}_user_email`,
    joins: `LEFT JOIN phis.user_profiles ${alias}_profile ON ${alias}_profile.user_id = ${idExpression}
            LEFT JOIN phis.user_account_directory ${alias}_directory ON ${alias}_directory.id = ${idExpression}`,
  };
}

type PersonColumns = { person_user_id: number | null; person_user_name: string | null; person_user_email: string | null };

function readPerson(row: PersonColumns): SiteReleasePerson | null {
  return row.person_user_id == null
    ? null
    : { userId: row.person_user_id, name: row.person_user_name, email: row.person_user_email };
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function readPlace(meta: unknown): SiteWidgetContentPlace | null {
  const place = (meta as { place?: unknown } | null)?.place;
  if (!place || typeof place !== "object") return null;
  const record = place as Record<string, unknown>;
  if (typeof record.area !== "string") return null;
  if (record.scope === "area") return { scope: "area", area: record.area };
  if (record.scope !== "page") return null;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    scope: "page",
    area: record.area,
    path: text(record.path),
    ownerModuleId: text(record.ownerModuleId),
    presetKey: text(record.presetKey),
  };
}

function clip(value: string | null, length = 160) {
  if (!value) return null;
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

/** Everything of this Site that waits for a Publisher, newest first within each kind. */
export async function listSiteReleases(siteId: number): Promise<SiteReleaseItem[]> {
  const pool = getPool();
  const writer = personSql("person", "v.created_by_user_id");
  const saver = personSql("person", "COALESCE((r.meta_json #>> '{saved,byUserId}')::int, r.created_by_user_id)");

  const [contents, pages, areas] = await Promise.all([
    pool.query<PersonColumns & {
      id: number;
      type: number;
      slug: string;
      instance_id: string | null;
      meta: unknown;
      submitted_version_id: number;
      current_version_id: number | null;
      published_version_id: number | null;
      asset_id: number | null;
      written_at: Date;
      preview: string | null;
    }>(
      `SELECT c.id, c.type, c.slug, c.instance_id, c.meta,
              c.submitted_version_id, c.current_version_id, c.published_version_id,
              v.asset_id, v.created_at AS written_at,
              ${writer.columns},
              (SELECT msg.msg
               FROM phis.site_content_version_text xt
               JOIN phis.tr_site_msg msg ON msg.id = xt.msg_id
               WHERE xt.version_id = v.id
               ORDER BY CASE xt.field_name WHEN 'title' THEN 0 ELSE 1 END, xt.field_name
               LIMIT 1) AS preview
       FROM phis.site_content c
       JOIN phis.site_content_versions v ON v.id = c.submitted_version_id
       ${writer.joins}
       WHERE c.site_id = $1
         AND c.submitted_version_id IS NOT NULL
       ORDER BY v.created_at DESC, c.id DESC
       LIMIT $2`,
      [siteId, SITE_RELEASES_LIMIT],
    ),
    pool.query<PersonColumns & {
      area_id: number;
      path: string | null;
      draft_path: string | null;
      owner_module_id: string | null;
      preset_key: string | null;
      revision_id: number;
      saved_at: string | null;
      created_at: Date;
    }>(
      `SELECT s.area_id, s.path, s.draft_path, s.owner_module_id, s.preset_key,
              r.id AS revision_id, r.meta_json #>> '{saved,at}' AS saved_at, r.created_at,
              ${saver.columns}
       FROM phis.site_page_scopes s
       JOIN phis.site_page_revisions r ON r.id = s.working_draft_revision_id
       ${saver.joins}
       WHERE s.site_id = $1
       ORDER BY COALESCE((r.meta_json #>> '{saved,at}')::timestamptz, r.created_at) DESC
       LIMIT $2`,
      [siteId, SITE_RELEASES_LIMIT],
    ),
    pool.query<PersonColumns & {
      area_id: number;
      part: "structure" | "modules";
      revision_id: number;
      owner_module_id: string | null;
      preset_key: string | null;
      saved_at: string | null;
      created_at: Date;
    }>(
      `SELECT drafts.area_id, drafts.part, r.id AS revision_id,
              r.tree_json #>> '{sourcePreset,ownerModuleId}' AS owner_module_id,
              r.tree_json #>> '{sourcePreset,presetKey}' AS preset_key,
              r.meta_json #>> '{saved,at}' AS saved_at, r.created_at,
              ${saver.columns}
       FROM (
         SELECT s.area_id, 'structure' AS part, s.working_draft_revision_id AS revision_id
         FROM phis.site_area_scopes s
         WHERE s.site_id = $1 AND s.working_draft_revision_id IS NOT NULL
         UNION ALL
         SELECT s.area_id, 'modules' AS part, s.working_module_draft_revision_id
         FROM phis.site_area_scopes s
         WHERE s.site_id = $1 AND s.working_module_draft_revision_id IS NOT NULL
       ) drafts
       JOIN phis.site_area_revisions r ON r.id = drafts.revision_id
       ${saver.joins}
       ORDER BY COALESCE((r.meta_json #>> '{saved,at}')::timestamptz, r.created_at) DESC`,
      [siteId],
    ),
  ]);

  const items: SiteReleaseItem[] = [];
  for (const row of contents.rows) {
    const storage = SITE_WIDGET_CONTENT_TYPES.includes(row.type) ? STORAGE_BY_TYPE.get(row.type) : undefined;
    if (storage && row.instance_id) {
      items.push({
        kind: "content",
        contentId: row.id,
        instanceId: row.instance_id,
        storage,
        submittedVersionId: row.submitted_version_id,
        currentVersionId: row.current_version_id,
        publishedVersionId: row.published_version_id,
        preview: storage === "asset" ? (row.asset_id == null ? null : String(row.asset_id)) : clip(row.preview),
        place: readPlace(row.meta),
        writtenAt: toIso(row.written_at),
        writtenBy: readPerson(row),
      });
      continue;
    }
    const entryKind = ENTRY_KIND_BY_TYPE.get(row.type);
    if (entryKind) {
      items.push({
        kind: "entry",
        entryKind,
        contentId: row.id,
        slug: row.slug,
        title: clip(row.preview),
        submittedVersionId: row.submitted_version_id,
        currentVersionId: row.current_version_id,
        publishedVersionId: row.published_version_id,
        writtenAt: toIso(row.written_at),
        writtenBy: readPerson(row),
      });
    }
  }
  for (const row of pages.rows) {
    items.push({
      kind: "page",
      area: resolvePhisCmsAreaKey(row.area_id),
      path: row.draft_path ?? row.path,
      ownerModuleId: row.owner_module_id,
      presetKey: row.preset_key,
      revisionId: row.revision_id,
      savedAt: row.saved_at ? new Date(row.saved_at).toISOString() : toIso(row.created_at),
      savedBy: readPerson(row),
    });
  }
  for (const row of areas.rows) {
    items.push({
      kind: "area",
      area: resolvePhisCmsAreaKey(row.area_id),
      part: row.part,
      revisionId: row.revision_id,
      ownerModuleId: row.owner_module_id,
      presetKey: row.preset_key,
      savedAt: row.saved_at ? new Date(row.saved_at).toISOString() : toIso(row.created_at),
      savedBy: readPerson(row),
    });
  }
  return items;
}
