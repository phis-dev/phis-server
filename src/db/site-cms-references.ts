import "server-only";

import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";
import { isPhisCmsAreaKey, resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
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
  Theme: 5,
} as const;

export type PhiCmsReferenceSourceKind = typeof PhiCmsReferenceSourceKind[keyof typeof PhiCmsReferenceSourceKind];

export type SiteCmsReferenceWrite = {
  location: string;
  reference: PhiInternalReference;
  targetAreaId?: number;
};

/**
 * Whether this field is how persisted config names an Asset.
 *
 * An Asset in a Markdown or HTML body is a `phis:asset/<id>` URI, and the string walk below finds it.
 * Config never had that shape: a picture somebody picked is stored as the id itself, next to the
 * variant, geometry and focal facts that belong to it -- `assetId` in an image source, and in each
 * mode of the Theme's brand Logo. A walk that only reads strings therefore saw none of them, which is
 * the whole reason a picture sitting in a Widget could be deleted while it was on the page.
 *
 * The field name is the contract, not the surrounding object: an id lands under `assetId` or under a
 * name ending in `AssetId`, whatever carries it. That keeps the rule readable in one line and makes a
 * new picture-bearing Widget index itself, rather than needing this list extended -- and REFERENCES.md
 * states it, so a Widget that stores an Asset anywhere else is authoring a reference nothing protects.
 */
function readPhiCmsAssetIdField(key: string, value: unknown): number | null {
  if (key !== "assetId" && !key.endsWith("AssetId")) return null;
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : null;
}

/**
 * Whether this field is how persisted config names a link target, and which Page it names.
 *
 * The Asset rule above and its reasoning, for the other thing config points at. A Widget that offers a
 * link stores a target object rather than an href -- a Page by reference, or an explicitly external
 * address -- and a walk that only reads strings would see neither, because the reference in config is
 * the bare identity and not the `phis:page/` URI that belongs to Markdown and HTML bodies.
 *
 * Answering `null` means "not a link target field" and lets the walk carry on into the value. Answering
 * a record means the field was one and the walk stops there, whether or not a Page came out of it. That
 * distinction is the guard: an external target's `href` is a literal URL the Site does not own, and
 * descending into it would let a `phis:page/` string typed into that box index itself as though somebody
 * had chosen the Page from the tree. A target says which kind it is; nothing below it gets a second say.
 *
 * The Navigation overlay's `/target/reference` is the same idea written as a path match, from before
 * there was a name to go by. It stays where it is; this rule is what a new Widget follows.
 */
function readPhiCmsLinkTargetField(
  key: string,
  value: unknown,
): { reference: PhiInternalReference | null; areaId?: number } | null {
  if (key !== "linkTarget" && !(key.endsWith("LinkTarget") && key.length > "LinkTarget".length)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reference: null };
  const target = value as Record<string, unknown>;
  if (target.kind !== "page") return { reference: null };
  const parsed = readPhiPageReference(target.reference);
  if (!parsed) return { reference: null };
  const fragment = typeof target.fragment === "string" ? target.fragment.replace(/^#/u, "").trim() : "";
  /*
   * A target may name the Area to resolve it in, and then that is the Area the row belongs to. Indexing
   * it under the Area of the tree it was written in would file a link to another Area's Page against the
   * Area that merely points at it.
   */
  const areaId = isPhisCmsAreaKey(target.area) ? resolvePhisCmsAreaMask(target.area) : undefined;
  return {
    reference: {
      kind: "page",
      reference: parsed.reference,
      target: parsed.target,
      fragment: fragment || null,
    },
    ...(areaId === undefined ? {} : { areaId }),
  };
}

export function collectSiteCmsReferences(
  value: unknown,
  options?: { targetAreaId?: number },
): SiteCmsReferenceWrite[] {
  const references: SiteCmsReferenceWrite[] = [];
  /*
   * A Module Page target is not indexed, and the absence is the contract rather than an oversight.
   *
   * The index exists for what the Site owns and can destroy: a foreign key refuses to delete a Page or
   * an Asset something still points at, and a path change counts what it affects. A Module Page is
   * neither -- the Site owns neither the Page nor its path, and switching the Module off is reversible,
   * takes its routes with it, and gives them back. A guard there would warn about an act that costs
   * nothing, and there is no row for a foreign key to point at in any case.
   */
  const push = (location: string, reference: PhiInternalReference, targetAreaId?: number) => {
    if (reference.kind === "page" && reference.target.kind === "module") {
      return;
    }
    const areaId = targetAreaId ?? options?.targetAreaId;
    references.push({
      location,
      reference,
      ...(reference.kind === "page" && areaId ? { targetAreaId: areaId } : {}),
    });
  };
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
        push(match.offset == null ? location : `${location}@${match.offset}`, match.reference);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${location}/${index}`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      const encodedKey = key.replaceAll("~", "~0").replaceAll("/", "~1");
      const assetId = readPhiCmsAssetIdField(key, entry);
      if (assetId != null) {
        push(`${location}/${encodedKey}`, { kind: "asset", assetId });
        continue;
      }
      const linkTarget = readPhiCmsLinkTargetField(key, entry);
      if (linkTarget) {
        if (linkTarget.reference) {
          push(`${location}/${encodedKey}`, linkTarget.reference, linkTarget.areaId);
        }
        continue;
      }
      visit(entry, `${location}/${encodedKey}`);
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
      targetKind: reference.kind === "asset" ? 3 : 1,
      targetAreaId:
        reference.kind === "page" && Number.isInteger(entry.targetAreaId) && (entry.targetAreaId ?? 0) > 0
          ? entry.targetAreaId!
          : null,
      pageScopeId:
        reference.kind === "page" && reference.target.kind === "site" ? reference.target.pageScopeId : null,
      assetId: reference.kind === "asset" ? reference.assetId : null,
      fragment: reference.kind === "page" ? reference.fragment : null,
    };
  });
  await db.query(
    `INSERT INTO phis.site_cms_references (
       site_id, source_kind, source_scope_id, source_revision_id, source_location,
       target_kind, target_area_id, target_page_scope_id, target_asset_id, fragment
     )
     SELECT $1, $2, $3, $4, location, target_kind, target_area_id, target_page_scope_id,
            target_asset_id, fragment
     FROM unnest(
       $5::text[], $6::smallint[], $7::smallint[], $8::int[], $9::int[], $10::text[]
     ) AS r(location, target_kind, target_area_id, target_page_scope_id,
            target_asset_id, fragment)`,
    [
      input.siteId,
      input.sourceKind,
      input.sourceScopeId,
      input.sourceRevisionId ?? null,
      rows.map((row) => row.location),
      rows.map((row) => row.targetKind),
      rows.map((row) => row.targetAreaId),
      rows.map((row) => row.pageScopeId),
      rows.map((row) => row.assetId),
      rows.map((row) => row.fragment),
    ],
  );
}

/** One indexed reference to an Asset, with what its source Scope says about where it sits. */
export type SiteCmsAssetReferenceRow = {
  sourceKind: number;
  sourceScopeId: number;
  sourceRevisionId: number | null;
  sourceLocation: string;
  targetAreaId: number | null;
  pagePath: string | null;
  sourceAreaId: number | null;
};

/**
 * Every live reference to one Asset, for the delete guard to refuse a deletion by.
 *
 * An Asset reference carries no target Area -- Assets are Site scoped. For an Area source the Area the
 * reference sits in is what names it, so it is read from the source Scope instead.
 *
 * The Scope join is also what keeps this honest about drafts. Page, Navigation, Area, and Theme sources
 * index the revision that was just written, and discarding a Working Draft removes that revision
 * without touching its rows. Such a row names a revision the Scope no longer points at from any of its
 * pointers, and is therefore disregarded here rather than swept somewhere else: the reader that would
 * act on it is the one place that can tell. Publishing promotes the draft revision instead of creating
 * one, so a published reference keeps matching. Content sources are exempt because their revision is a
 * content version, and the orphan collector already removes their rows when a discarded Draft leaves
 * the content unreferenced.
 *
 * An Area Scope carries three pointers. Its Module draft is a Working Draft in its own right -- the one
 * a Module writes when somebody edits what the Module contributes -- and leaving it out read every
 * picture a Module had just placed as the residue of a discarded draft.
 */
export async function listSiteCmsReferencesToAsset(
  siteId: number,
  assetId: number,
): Promise<SiteCmsAssetReferenceRow[]> {
  const { rows } = await getPool().query<{
    source_kind: number;
    source_scope_id: number;
    source_revision_id: number | null;
    source_location: string;
    target_area_id: number | null;
    page_path: string | null;
    source_area_id: number | null;
  }>(
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
     LEFT JOIN phis.site_theme_scopes theme_scope
       ON ref.source_kind = 5 AND theme_scope.site_id = ref.site_id AND theme_scope.id = ref.source_scope_id
     WHERE ref.site_id = $1 AND ref.target_asset_id = $2
       AND (
         ref.source_revision_id IS NULL
         OR ref.source_kind = 3
         OR (ref.source_kind = 1 AND ref.source_revision_id IN (
              page_scope.published_revision_id, page_scope.working_draft_revision_id))
         OR (ref.source_kind = 2 AND ref.source_revision_id IN (
              nav_scope.published_revision_id, nav_scope.working_draft_revision_id))
         OR (ref.source_kind = 4 AND ref.source_revision_id IN (
              area_scope.published_revision_id, area_scope.working_draft_revision_id,
              area_scope.working_module_draft_revision_id))
         OR (ref.source_kind = 5 AND ref.source_revision_id IN (
              theme_scope.published_revision_id, theme_scope.working_draft_revision_id))
       )
     ORDER BY ref.source_kind, ref.source_scope_id, ref.source_location`,
    [siteId, assetId],
  );
  return rows.map((row) => ({
    sourceKind: row.source_kind,
    sourceScopeId: row.source_scope_id,
    sourceRevisionId: row.source_revision_id,
    sourceLocation: row.source_location,
    targetAreaId: row.target_area_id,
    pagePath: row.page_path,
    sourceAreaId: row.source_area_id,
  }));
}

export async function countSiteCmsReferencesToPageWithDb(
  db: DbQueryable,
  siteId: number,
  pageScopeId: number,
) {
  // The same reconciliation the Asset delete guard reads by: a row naming a revision its Scope points
  // at from none of its pointers belongs to a discarded Working Draft and is not an affected reference.
  // Counting it would report a rename as more disruptive than it is. Content sources are exempt --
  // their revision is a content version, and the orphan collector already removes their rows.
  //
  // An Area Scope has three pointers, not two: a Module draft is a live Working Draft of its own. The
  // Theme source is absent here because it cannot name a Page -- it is Site wide, so it has no Area to
  // resolve one in, and the writer rejects a Page reference that names none.
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
              area_scope.published_revision_id, area_scope.working_draft_revision_id,
              area_scope.working_module_draft_revision_id))
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
