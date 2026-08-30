import "server-only";

import type { PoolClient } from "pg";

import {
  collectPhiInternalReferencesFromText,
  readPhiInternalReference,
  readPhiPageReference,
  type PhiInternalReference,
} from "@/lib/internal-references";

export const PhiCmsReferenceSourceKind = {
  Page: 1,
  Navigation: 2,
  Content: 3,
  Area: 4,
} as const;

export type PhiCmsReferenceSourceKind = typeof PhiCmsReferenceSourceKind[keyof typeof PhiCmsReferenceSourceKind];

export type SiteCmsReferenceWrite = {
  location: string;
  reference: PhiInternalReference;
  targetAreaId?: number;
};

export function collectSiteCmsReferences(
  value: unknown,
  options?: { targetAreaId?: number },
): SiteCmsReferenceWrite[] {
  const references: SiteCmsReferenceWrite[] = [];
  const visit = (node: unknown, location: string) => {
    if (typeof node === "string") {
      const structuredNavigationReference = location.endsWith("/target/reference")
        ? readPhiPageReference(node)
        : null;
      const reference = readPhiInternalReference(node) ?? (structuredNavigationReference ? {
        kind: "page" as const,
        reference: structuredNavigationReference.reference,
        target: structuredNavigationReference.target,
        fragment: null,
      } : null);
      const embedded = reference
        ? [{ reference, offset: null }]
        : collectPhiInternalReferencesFromText(node);
      for (const match of embedded) {
        references.push({
          location: match.offset == null ? location : `${location}@${match.offset}`,
          reference: match.reference,
          ...(match.reference.kind === "page" && options?.targetAreaId
            ? { targetAreaId: options.targetAreaId }
            : {}),
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${location}/${index}`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      visit(entry, `${location}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    }
  };
  visit(value, "");
  return references;
}

/**
 * Collects the references carried by one persisted trusted-content body.
 *
 * The field name becomes the `source_location` root so a Content row keeps the same location grammar
 * as Page and Navigation sources.
 */
export function collectSiteCmsContentReferences(
  field: "html" | "markdown",
  value: string,
  options: { targetAreaId: number },
): SiteCmsReferenceWrite[] {
  return collectSiteCmsReferences({ [field]: value }, options);
}

type DbQueryable = Pick<PoolClient, "query">;

export async function deleteSiteCmsReferencesForSourceWithDb(
  db: DbQueryable,
  input: { siteId: number; sourceKind: PhiCmsReferenceSourceKind; sourceScopeId: number },
) {
  await db.query(
    `DELETE FROM phis.site_cms_references
     WHERE site_id = $1 AND source_kind = $2 AND source_scope_id = $3`,
    [input.siteId, input.sourceKind, input.sourceScopeId],
  );
}

export async function replaceSiteCmsReferencesWithDb(
  db: DbQueryable,
  input: {
    siteId: number;
    sourceKind: PhiCmsReferenceSourceKind;
    sourceScopeId: number;
    sourceRevisionId?: number | null;
    references: readonly SiteCmsReferenceWrite[];
  },
) {
  const assetIds = [...new Set(input.references.flatMap((entry) =>
    entry.reference.kind === "asset" ? [entry.reference.assetId] : [],
  ))];
  if (assetIds.length > 0) {
    const { rows } = await db.query<{ id: number }>(
      `SELECT a.id
       FROM phis.media_assets a
       JOIN phis.media_spaces s ON s.id = a.space_id AND s.site_id = a.site_id
       WHERE a.site_id = $1 AND s.kind = 1 AND a.id = ANY($2::bigint[])`,
      [input.siteId, assetIds],
    );
    const validIds = new Set(rows.map((row) => row.id));
    const invalidId = assetIds.find((assetId) => !validIds.has(assetId));
    if (invalidId != null) {
      throw new Error(`CMS Asset reference #${invalidId} is not owned by this Site Media Space.`);
    }
  }
  await deleteSiteCmsReferencesForSourceWithDb(db, input);
  if (input.references.length === 0) return;

  // One multi-row insert instead of one round trip per reference: a Page save carries every reference
  // of its tree, so per-row statements serialize the whole save on network latency.
  const rows = input.references.map((entry) => {
    const reference = entry.reference;
    if (reference.kind === "page" && (!Number.isInteger(entry.targetAreaId) || (entry.targetAreaId ?? 0) <= 0)) {
      throw new Error(`Page reference at "${entry.location}" requires a target Area id.`);
    }
    return {
      location: entry.location,
      targetKind: reference.kind === "asset" ? 3 : reference.target.kind === "site" ? 1 : 2,
      targetAreaId:
        reference.kind === "page" && Number.isInteger(entry.targetAreaId) && (entry.targetAreaId ?? 0) > 0
          ? entry.targetAreaId!
          : null,
      pageScopeId:
        reference.kind === "page" && reference.target.kind === "site" ? reference.target.pageScopeId : null,
      ownerModuleId:
        reference.kind === "page" && reference.target.kind === "module" ? reference.target.ownerModuleId : null,
      presetKey:
        reference.kind === "page" && reference.target.kind === "module" ? reference.target.presetKey : null,
      assetId: reference.kind === "asset" ? reference.assetId : null,
      fragment: reference.kind === "page" ? reference.fragment : null,
    };
  });
  await db.query(
    `INSERT INTO phis.site_cms_references (
       site_id, source_kind, source_scope_id, source_revision_id, source_location,
       target_kind, target_area_id, target_page_scope_id, target_owner_module_id,
       target_preset_key, target_asset_id, fragment
     )
     SELECT $1, $2, $3, $4, location, target_kind, target_area_id, target_page_scope_id,
            target_owner_module_id, target_preset_key, target_asset_id, fragment
     FROM unnest(
       $5::text[], $6::smallint[], $7::smallint[], $8::int[], $9::text[], $10::text[], $11::int[], $12::text[]
     ) AS r(location, target_kind, target_area_id, target_page_scope_id,
            target_owner_module_id, target_preset_key, target_asset_id, fragment)`,
    [
      input.siteId,
      input.sourceKind,
      input.sourceScopeId,
      input.sourceRevisionId ?? null,
      rows.map((row) => row.location),
      rows.map((row) => row.targetKind),
      rows.map((row) => row.targetAreaId),
      rows.map((row) => row.pageScopeId),
      rows.map((row) => row.ownerModuleId),
      rows.map((row) => row.presetKey),
      rows.map((row) => row.assetId),
      rows.map((row) => row.fragment),
    ],
  );
}

export async function countSiteCmsReferencesToPageWithDb(
  db: DbQueryable,
  siteId: number,
  pageScopeId: number,
) {
  // The same reconciliation the Asset delete guard reads by: a row naming a revision its Scope points
  // at from neither pointer belongs to a discarded Working Draft and is not an affected reference.
  // Counting it would report a rename as more disruptive than it is. Content sources are exempt --
  // their revision is a content version, and the orphan collector already removes their rows.
  const { rows } = await db.query<{ source_kind: number; count: string }>(
    `SELECT ref.source_kind, COUNT(*)::text AS count
     FROM phis.site_cms_references ref
     LEFT JOIN phis.site_page_scopes page_scope
       ON ref.source_kind = 1 AND page_scope.id = ref.source_scope_id
     LEFT JOIN phis.site_nav_scopes nav_scope
       ON ref.source_kind = 2 AND nav_scope.site_id = ref.site_id AND nav_scope.id = ref.source_scope_id
     LEFT JOIN phis.site_area_scopes area_scope
       ON ref.source_kind = 4 AND area_scope.site_id = ref.site_id AND area_scope.id = ref.source_scope_id
     WHERE ref.site_id = $1 AND ref.target_page_scope_id = $2
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
     GROUP BY ref.source_kind`,
    [siteId, pageScopeId],
  );
  const bySource = { page: 0, navigation: 0, content: 0, area: 0 };
  for (const row of rows) {
    const count = Number.parseInt(row.count, 10) || 0;
    if (row.source_kind === PhiCmsReferenceSourceKind.Page) bySource.page = count;
    if (row.source_kind === PhiCmsReferenceSourceKind.Navigation) bySource.navigation = count;
    if (row.source_kind === PhiCmsReferenceSourceKind.Content) bySource.content = count;
    if (row.source_kind === PhiCmsReferenceSourceKind.Area) bySource.area = count;
  }
  return {
    total: bySource.page + bySource.navigation + bySource.content + bySource.area,
    bySource,
  };
}
