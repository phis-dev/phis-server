import "server-only";

import type { MediaAssetRecord } from "@/db/media";
import { listSiteCmsReferencesToAsset } from "@/db/site-cms-references";

export type MediaDeleteGuardReference = {
  scope: "page" | "navigation" | "content" | "area" | "theme";
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
  const rows = await listSiteCmsReferencesToAsset(siteId, asset.id);
  return rows.map((row) => ({
    scope:
      row.sourceKind === 1
        ? "page"
        : row.sourceKind === 2
          ? "navigation"
          : row.sourceKind === 4
            ? "area"
            : row.sourceKind === 5
              ? "theme"
              : "content",
    pageId: row.sourceKind === 1 ? row.sourceScopeId : null,
    pagePath: row.pagePath,
    areaMask: row.targetAreaId ?? row.sourceAreaId,
    areaPresetId: null,
    regionId: null,
    regionType: null,
    regionKey: null,
    slotIndex: null,
    layoutNodeId: null,
    widgetId: null,
    widgetType: null,
    contentId: row.sourceKind === 3 ? row.sourceScopeId : null,
    contentType: null,
    contentSlug: null,
    contentVersionId: row.sourceRevisionId,
    fieldPath: row.sourceLocation,
    matchType: "assetId",
    matchedValue: String(asset.id),
  }));
}
