import type { PoolClient } from "pg";

/**
 * Where a Module's blocks stand on a Site's published trees.
 *
 * Asked twice, from two sides: the Builder asks before switching a Module off for one Area, and
 * `phis module del` asks before taking the package out of the build entirely. Both are the moment
 * the answer changes something -- the blocks stay in their pages and stop being drawn -- so the
 * query lives here, alone, rather than once per caller.
 *
 * It needs no Module knowledge to answer: a stored node carries its owner inside its type, as in
 * "@phis/example/modules/site/widgets/note". It looks at the published revision, because that is what a
 * visitor gets; an unsaved draft takes its blocks away when it is published, which is a different
 * sentence and belongs in a different place.
 */

type DbQueryable = Pick<PoolClient, "query">;

export type SiteModuleBlockUsageRecord = {
  kind: "page" | "area";
  pageScopeId: number | null;
  path: string | null;
  /** A Module Page has no path of its own; it is named by the preset it came from. */
  ownerModuleId: string | null;
  presetKey: string | null;
  blocks: number;
};

const MODULE_BLOCK_USAGE_PREDICATE = `(
  EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(r.tree_json -> 'contentWidgets', '[]'::jsonb)) AS node
    WHERE node ->> 'widgetType' LIKE $3
  )
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(r.tree_json -> 'layoutNodes', '[]'::jsonb)) AS node
    WHERE node ->> 'widgetType' LIKE $3
  )
)`;

const MODULE_BLOCK_COUNT = `(
  (SELECT count(*) FROM jsonb_array_elements(COALESCE(r.tree_json -> 'contentWidgets', '[]'::jsonb)) AS node
    WHERE node ->> 'widgetType' LIKE $3)
  + (SELECT count(*) FROM jsonb_array_elements(COALESCE(r.tree_json -> 'layoutNodes', '[]'::jsonb)) AS node
    WHERE node ->> 'widgetType' LIKE $3)
)`;

/**
 * @param ownerId A Module id, or the name of the package that carries it. One package carries one
 * product, so every block a package owns begins with the package name and the wider question --
 * "what does this whole package draw here" -- is the same query with a shorter prefix.
 */
export async function listSiteModuleBlockUsageWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  ownerId: string,
): Promise<SiteModuleBlockUsageRecord[]> {
  const trimmedOwnerId = ownerId.trim();
  if (
    !Number.isInteger(siteId) || siteId <= 0 ||
    !Number.isInteger(areaMask) || areaMask <= 0 ||
    trimmedOwnerId.length === 0
  ) {
    return [];
  }

  const typePrefix = `${trimmedOwnerId}/%`;
  const { rows: pageRows } = await db.query<{
    id: number;
    path: string | null;
    owner_module_id: string | null;
    preset_key: string | null;
    blocks: string;
  }>(
    `SELECT s.id, s.path, s.owner_module_id, s.preset_key, ${MODULE_BLOCK_COUNT} AS blocks
       FROM phis.site_page_scopes s
       JOIN phis.site_page_revisions r ON r.id = s.published_revision_id
      WHERE s.site_id = $1
        AND s.area_id = $2
        AND s.tombstoned_at IS NULL
        AND ${MODULE_BLOCK_USAGE_PREDICATE}
      ORDER BY s.path NULLS LAST, s.id`,
    [siteId, areaMask, typePrefix],
  );

  const { rows: areaRows } = await db.query<{ blocks: string }>(
    `SELECT ${MODULE_BLOCK_COUNT} AS blocks
       FROM phis.site_area_scopes s
       JOIN phis.site_area_revisions r ON r.id = s.published_revision_id
      WHERE s.site_id = $1
        AND s.area_id = $2
        AND ${MODULE_BLOCK_USAGE_PREDICATE}`,
    [siteId, areaMask, typePrefix],
  );

  return [
    ...areaRows
      .map((row) => Number(row.blocks))
      .filter((blocks) => blocks > 0)
      .map((blocks) => ({
        kind: "area" as const,
        pageScopeId: null,
        path: null,
        ownerModuleId: null,
        presetKey: null,
        blocks,
      })),
    ...pageRows.map((row) => ({
      kind: "page" as const,
      pageScopeId: row.id,
      path: row.path,
      ownerModuleId: row.owner_module_id,
      presetKey: row.preset_key,
      blocks: Number(row.blocks),
    })),
  ];
}
