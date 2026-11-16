import type { PoolClient } from "pg";

import { readPhiCmsInstanceIdDescriptor } from "../lib/cms/instance-id.ts";
import { PhiCmsReferenceSourceKind } from "./site-revision-pointers.mts";

/*
 * The Content sweep that follows a removed Page or Area revision (CONTENT.md, Lifecycle).
 *
 * In a module free of `server-only` and the `@/` alias so the Server and `phis page reset` run the one
 * implementation; `site-widget-content.ts` re-exports it.
 */

type DbQueryable = Pick<PoolClient, "query">;

/** A preset node is the Module's until a content write binds it; a draft node is the Site's from the start. */
export function isPresetWidgetInstance(instanceId: string) {
  return readPhiCmsInstanceIdDescriptor(instanceId)?.origin === "preset";
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
