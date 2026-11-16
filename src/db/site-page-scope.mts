import type { PoolClient } from "pg";

import { phiPrepared } from "../lib/db-prepared.ts";
import { normalizeSiteCmsPath } from "../lib/helpers/cms-path.ts";

/*
 * A Site's stored Page scope, looked up by path or by the preset it overrides.
 *
 * In a module free of `server-only` and the `@/` alias because `phis page reset` reads it through the
 * same function the Builder's reset does; `site-pages.ts` imports it from here.
 */

type DbQueryable = Pick<PoolClient, "query">;

export type SitePageScopeRecord = {
  id: number;
  siteId: number;
  areaMask: number;
  path: string | null;
  /** The path a published change would move this Page to, or null while none stands. */
  draftPath: string | null;
  ownerModuleId: string | null;
  presetKey: string | null;
  tombstonedAt: string | null;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
};

export type SitePageScopeAddress =
  | { kind: "path"; path: string }
  | { kind: "preset"; ownerModuleId: string; presetKey: string };

export async function getSitePageScopeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  address: SitePageScopeAddress,
  options?: { forUpdate?: boolean },
): Promise<SitePageScopeRecord | null> {
  const normalizedPath = address.kind === "path" ? normalizeSiteCmsPath(address.path) : null;
  const { rows } = await db.query<{
    id: number;
    site_id: number;
    area_id: number;
    path: string | null;
    draft_path: string | null;
    owner_module_id: string | null;
    preset_key: string | null;
    tombstoned_at: Date | string | null;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(phiPrepared(
    `SELECT id, site_id, area_id, path, draft_path, owner_module_id, preset_key, tombstoned_at,
            published_revision_id, working_draft_revision_id
     FROM phis.site_page_scopes
     WHERE site_id = $1
       AND area_id = $2
       AND ${address.kind === "path"
         ? "path = $3 AND owner_module_id IS NULL AND preset_key IS NULL"
         : "path IS NULL AND owner_module_id = $3 AND preset_key = $4"}
     LIMIT 1
     ${options?.forUpdate ? "FOR UPDATE" : ""}`,
    address.kind === "path"
      ? [siteId, areaMask, normalizedPath]
      : [siteId, areaMask, address.ownerModuleId, address.presetKey],
  ));
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    siteId: row.site_id,
    areaMask: row.area_id,
    path: row.path,
    draftPath: row.draft_path,
    ownerModuleId: row.owner_module_id,
    presetKey: row.preset_key,
    tombstonedAt: row.tombstoned_at == null
      ? null
      : row.tombstoned_at instanceof Date
        ? row.tombstoned_at.toISOString()
        : String(row.tombstoned_at),
    publishedRevisionId: row.published_revision_id,
    workingDraftRevisionId: row.working_draft_revision_id,
  };
}
