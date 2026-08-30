import "server-only";

import type { MediaAssetRecord } from "@/db/media";
import { getPool } from "@/lib/db";

export type MediaDeleteGuardReference = {
  scope: "page" | "navigation" | "content" | "area";
  pageId: number | null;
  pagePath: string | null;
  areaMask: number | null;
  areaPresetId: number | null;
  regionId: number | null;
  regionType: number | null;
  regionKey: string | null;
  slotIndex: number | null;
  layoutNodeId: null;
  widgetId: null;
  widgetType: null;
  contentId: number | null;
  contentType: null;
  contentSlug: null;
  contentVersionId: number | null;
  fieldPath: string;
  matchType: "assetId";
  matchedValue: string;
};

export async function collectMediaAssetDeleteReferences(
  siteId: number,
  asset: MediaAssetRecord,
): Promise<MediaDeleteGuardReference[]> {
  if (!Number.isInteger(siteId) || siteId <= 0 || asset.siteId !== siteId) return [];
  const { rows } = await getPool().query<{
    source_kind: number;
    source_scope_id: number;
    source_revision_id: number | null;
    source_location: string;
    target_area_id: number | null;
    page_path: string | null;
    source_area_id: number | null;
  }>(
    // An Asset reference carries no target Area -- Assets are Site scoped. For an Area source the Area
    // the reference sits in is what names it, so it is read from the source Scope instead.
    //
    // The Scope join is also what keeps this honest about drafts. Page, Navigation, and Area sources
    // index the revision that was just written, and discarding a Working Draft removes that revision
    // without touching its rows. Such a row names a revision the Scope no longer points at from either
    // pointer, and is therefore disregarded here rather than swept somewhere else: the reader that
    // would act on it is the one place that can tell. Publishing promotes the draft revision instead
    // of creating one, so a published reference keeps matching. Content sources are exempt because
    // their revision is a content version, and the orphan collector already removes their rows when a
    // discarded Draft leaves the content unreferenced.
    `SELECT ref.source_kind, ref.source_scope_id, ref.source_revision_id,
            ref.source_location, ref.target_area_id, page_scope.path AS page_path,
            area_scope.area_id AS source_area_id
     FROM phis.site_cms_references ref
     LEFT JOIN phis.site_page_scopes page_scope
       ON ref.source_kind = 1 AND page_scope.id = ref.source_scope_id
     LEFT JOIN phis.site_nav_scopes nav_scope
       ON ref.source_kind = 2 AND nav_scope.site_id = ref.site_id AND nav_scope.id = ref.source_scope_id
     LEFT JOIN phis.site_area_scopes area_scope
       ON ref.source_kind = 4 AND area_scope.site_id = ref.site_id AND area_scope.id = ref.source_scope_id
     WHERE ref.site_id = $1 AND ref.target_asset_id = $2
       AND (
         ref.source_revision_id IS NULL
         OR ref.source_kind = 3
         OR (ref.source_kind = 1 AND ref.source_revision_id IN (
              page_scope.published_revision_id, page_scope.working_draft_revision_id))
         OR (ref.source_kind = 2 AND ref.source_revision_id IN (
              nav_scope.published_revision_id, nav_scope.working_draft_revision_id))
         OR (ref.source_kind = 4 AND ref.source_revision_id IN (
              area_scope.published_revision_id, area_scope.working_draft_revision_id))
       )
     ORDER BY ref.source_kind, ref.source_scope_id, ref.source_location`,
    [siteId, asset.id],
  );
  return rows.map((row) => ({
    scope:
      row.source_kind === 1
        ? "page"
        : row.source_kind === 2
          ? "navigation"
          : row.source_kind === 4
            ? "area"
            : "content",
    pageId: row.source_kind === 1 ? row.source_scope_id : null,
    pagePath: row.page_path,
    areaMask: row.target_area_id ?? row.source_area_id,
    areaPresetId: null,
    regionId: null,
    regionType: null,
    regionKey: null,
    slotIndex: null,
    layoutNodeId: null,
    widgetId: null,
    widgetType: null,
    contentId: row.source_kind === 3 ? row.source_scope_id : null,
    contentType: null,
    contentSlug: null,
    contentVersionId: row.source_revision_id,
    fieldPath: row.source_location,
    matchType: "assetId",
    matchedValue: String(asset.id),
  }));
}
