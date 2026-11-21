import "server-only";

import type { PoolClient } from "pg";

import type { MediaAssetRecord } from "@/db/media";
import { listProductIdsWithImage } from "@/db/products.mts";
import { getPool } from "@/lib/db";
import { listSiteCmsReferencesToAsset } from "@/db/site-cms-references";
import {
  listPhisAddonRowsReferencingMediaAsset,
  type PhisAddonMediaReferenceColumn,
} from "@/db/server-addon-media-references.mts";
import { PHIS_ADDON_CORE_REFERENCES } from "@/lib/addons/contract";
import { getPhisAddonInstalledManifest } from "@/lib/addons/installed";
import { derivePhisAddonSchemaName } from "@/lib/addons/schema-name";

export type MediaDeleteGuardReference = {
  /**
   * `product`: a product of the Site wears the Asset as its picture; `fieldPath` carries the product's id.
   * `addon`: a row of an installed Add-on's table names it in a `core.mediaAsset` column; `addon` says
   * which, and `fieldPath` is `<table>.<column>`.
   */
  scope: "page" | "navigation" | "content" | "area" | "theme" | "product" | "addon";
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
  /** Set exactly for scope `addon`: the Add-on, its table and column, and the row's primary key as text. */
  addon: {
    addonId: string;
    packageName: string;
    table: string;
    column: string;
    /** A composite key's values joined by `,` in key order. */
    rowId: string;
  } | null;
};

/**
 * Every column of an installed Add-on that points at `core.mediaAsset`, read from the descriptors.
 *
 * Installed, not enabled: an Add-on switched off -- for the Site or everywhere -- keeps its rows, and its
 * foreign key would still take them along with the Asset. Which of these columns the database actually
 * holds yet is the reader's question. The link tables Core keeps beside a table with slots are not
 * columns of the descriptor and so are not here: they hold the Add-on's own uploads, and deleting one in
 * the Media view is meant to clear its slot (SERVER_ADDONS.md, the asset tables).
 */
function listInstalledAddonMediaReferenceColumns(): PhisAddonMediaReferenceColumn[] {
  return Object.values(getPhisAddonInstalledManifest()).flatMap(({ manifest }) => {
    const tables = manifest.schema?.tables ?? [];
    return tables.flatMap((table) => table.siteScoped !== true ? [] : table.columns.flatMap((column) =>
      "references" in column && column.references === PHIS_ADDON_CORE_REFERENCES.mediaAsset
        ? [{
            addonId: manifest.addonId,
            packageName: manifest.packageName,
            schemaName: derivePhisAddonSchemaName(manifest.addonId),
            table: table.name,
            column: column.name,
            primaryKey: table.primaryKey,
          }]
        : []));
  });
}

export async function collectMediaAssetDeleteReferences(
  siteId: number,
  asset: Pick<MediaAssetRecord, "id" | "siteId">,
  /** A transaction holding the Asset's row lock, where the answer must hold until it commits. */
  db: Pick<PoolClient, "query"> = getPool(),
): Promise<MediaDeleteGuardReference[]> {
  if (!Number.isInteger(siteId) || siteId <= 0 || asset.siteId !== siteId) return [];
  const rows = await listSiteCmsReferencesToAsset(siteId, asset.id, db);
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
    addon: null,
  }));
  // A product's picture is held by an ON DELETE SET NULL foreign key as the last safeguard; the refusal
  // is the same one a CMS reference earns, so the picture is not taken from a product by accident.
  for (const productId of await listProductIdsWithImage(db, siteId, asset.id)) {
    references.push({
      scope: "product",
      pageId: null, pagePath: null, areaMask: null, areaPresetId: null, regionId: null, regionType: null,
      regionKey: null, slotIndex: null, layoutNodeId: null, widgetId: null, widgetType: null, contentId: null,
      contentType: null, contentSlug: null, contentVersionId: null,
      fieldPath: productId,
      matchType: "assetId",
      matchedValue: String(asset.id),
      addon: null,
    });
  }
  // An Add-on's own column is held by a foreign key Core derived, which takes the row (or clears the
  // column) when the Asset goes; refused here the same way, so nobody loses an Add-on's record by deleting
  // a file in the Media view.
  const addonRows = await listPhisAddonRowsReferencingMediaAsset(db, {
    siteId,
    assetId: asset.id,
    columns: listInstalledAddonMediaReferenceColumns(),
  });
  for (const { source, rowId } of addonRows) {
    references.push({
      scope: "addon",
      pageId: null, pagePath: null, areaMask: null, areaPresetId: null, regionId: null, regionType: null,
      regionKey: null, slotIndex: null, layoutNodeId: null, widgetId: null, widgetType: null, contentId: null,
      contentType: null, contentSlug: null, contentVersionId: null,
      fieldPath: `${source.table}.${source.column}`,
      matchType: "assetId",
      matchedValue: String(asset.id),
      addon: {
        addonId: source.addonId,
        packageName: source.packageName,
        table: source.table,
        column: source.column,
        rowId,
      },
    });
  }
  return references;
}
