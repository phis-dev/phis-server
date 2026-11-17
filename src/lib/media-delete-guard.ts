import "server-only";

import type { MediaAssetRecord } from "@/db/media";
import { listProductIdsWithImage } from "@/db/products.mts";
import { getPool } from "@/lib/db";
import { listSiteCmsReferencesToAsset } from "@/db/site-cms-references";

export type MediaDeleteGuardReference = {
  /** `product`: a product of the Site wears the Asset as its picture; `fieldPath` carries the product's id. */
  scope: "page" | "navigation" | "content" | "area" | "theme" | "product";
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
  const references: MediaDeleteGuardReference[] = rows.map((row): MediaDeleteGuardReference => ({
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
  // A product's picture is held by an ON DELETE SET NULL foreign key as the last safeguard; the refusal
  // is the same one a CMS reference earns, so the picture is not taken from a product by accident.
  for (const productId of await listProductIdsWithImage(getPool(), siteId, asset.id)) {
    references.push({
      scope: "product",
      pageId: null, pagePath: null, areaMask: null, areaPresetId: null, regionId: null, regionType: null,
      regionKey: null, slotIndex: null, layoutNodeId: null, widgetId: null, widgetType: null, contentId: null,
      contentType: null, contentSlug: null, contentVersionId: null,
      fieldPath: productId,
      matchType: "assetId",
      matchedValue: String(asset.id),
    });
  }
  return references;
}
