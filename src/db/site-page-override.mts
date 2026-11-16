import type { PoolClient } from "pg";

import { collectRevisionWidgetInstanceIds, deleteOrphanedSiteWidgetContentWithDb } from "./site-widget-content-sweep.mts";
import { getSitePageScopeWithDb } from "./site-page-scope.mts";
import { PhiCmsReferenceSourceKind, setSiteRevisionScopePointersWithDb } from "./site-revision-pointers.mts";

/*
 * The one deletion behind "Reset to preset": the Builder's route (`handleSiteCmsPageOverrideDelete`)
 * and `phis page reset` both run it. It sits in a module free of `server-only` and the `@/` alias because
 * the CLI cannot import the rest of the database layer; `deleteSitePageOverride` in `site-pages.ts` wraps
 * it in the Server's transaction.
 */

/**
 * Removes the Site's own override of a Module's Page, leaving the preset to answer for it again
 * (CONTENT.md, Reset).
 *
 * Structure only. The Page's revisions and pointers go, and with them every Widget the Site added to the
 * preset; the content written for the preset's own nodes stays bound to them and is shown by the preset
 * tree. What is live changes at once -- there is no override left to publish -- so the caller is the
 * publishing authority. A Page the Site made has no preset to go back to and is not matched.
 *
 * Runs on the caller's transaction. The change markers move by the trigger on `site_page_scopes`.
 */
export async function deleteSitePageOverrideWithDb(
  client: PoolClient,
  siteId: number,
  input: {
    areaMask: number;
    sourcePreset: { ownerModuleId: string; presetKey: string };
  },
): Promise<{ deleted: boolean }> {
  const scope = await getSitePageScopeWithDb(client, siteId, input.areaMask, {
    kind: "preset",
    ownerModuleId: input.sourcePreset.ownerModuleId,
    presetKey: input.sourcePreset.presetKey,
  }, { forUpdate: true });
  if (!scope) {
    return { deleted: false };
  }

  await setSiteRevisionScopePointersWithDb(client, { scopeTable: "site_page_scopes", referenceSourceKind: PhiCmsReferenceSourceKind.Page }, scope.id, {
    publishedRevisionId: null,
    workingDraftRevisionId: null,
  });
  const removed = await client.query<{ tree_json: Record<string, unknown> }>(
    `DELETE FROM phis.site_page_revisions WHERE page_scope_id = $1 RETURNING tree_json`,
    [scope.id],
  );
  await deleteOrphanedSiteWidgetContentWithDb(
    client,
    siteId,
    removed.rows.flatMap((row) => collectRevisionWidgetInstanceIds(row.tree_json ?? null)),
  );
  await client.query(
    `DELETE FROM phis.site_cms_references
     WHERE site_id = $1 AND source_kind = $2 AND source_scope_id = $3`,
    [siteId, PhiCmsReferenceSourceKind.Page, scope.id],
  );
  await client.query(
    `DELETE FROM phis.site_page_scopes
     WHERE id = $1
       AND published_revision_id IS NULL
       AND working_draft_revision_id IS NULL`,
    [scope.id],
  );
  return { deleted: removed.rowCount != null && removed.rowCount > 0 };
}
