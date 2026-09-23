import "server-only";

import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";

type DbQueryable = Pick<PoolClient, "query">;

/**
 * The Module ids a Site currently runs, across every published Area.
 *
 * Read rather than materialized, unlike Media availability and thread kinds: those are capabilities a
 * Site advertises and writes to a configuration row on publish, while this answers one question at the
 * moment it is asked -- may this key be written. A stored copy would be a second truth to keep in step
 * with the publish that already changed the first one.
 *
 * The union crosses Areas on purpose. Activation is stored per Area because a Module is placed per Area,
 * but what a person decided about a Module is theirs on this Site: a card dismissed in App stays
 * dismissed when the same Module draws it in Admin. Asking per Area would make the answer depend on
 * which Area the request happened to come from, which is not a property of the decision.
 *
 * Only published revisions count. A Module switched on in a draft is not running yet, and a Site whose
 * draft is mid-edit must not start accepting writes for it.
 */
export async function listPhiSiteActiveModuleIdsWithDb(
  db: DbQueryable,
  siteId: number,
): Promise<string[]> {
  const { rows } = await db.query<{ module_ids: unknown }>(
    `SELECT revision.tree_json #> '{preset,config,modules,runtimeModules}' AS module_ids
     FROM phis.site_area_scopes scope
     JOIN phis.site_area_revisions revision ON revision.id = scope.published_revision_id
     WHERE scope.site_id = $1`,
    [siteId],
  );

  const union = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.module_ids)) {
      continue;
    }
    for (const moduleId of row.module_ids) {
      if (typeof moduleId === "string" && moduleId.trim()) {
        union.add(moduleId.trim());
      }
    }
  }
  return [...union].sort();
}

export async function listPhiSiteActiveModuleIds(siteId: number) {
  return listPhiSiteActiveModuleIdsWithDb(getPool(), siteId);
}

/**
 * The active Module a key belongs to, or `null` when no active Module owns it.
 *
 * A key is `<module id>/<key>`, so ownership is a prefix and nothing has to be parsed: the longest
 * active id the key starts with is its owner. Longest wins because ids nest -- a Site running both
 * `@acme/shop/modules/shop` and a hypothetical `@acme/shop/modules/shop-admin` must not have one answer
 * for the other's keys.
 *
 * The trailing separator is what keeps `@acme/shop/modules/shop-admin/x` from being read as a key of
 * `@acme/shop/modules/shop`, and the remainder must be non-empty so a bare Module id is not a key.
 */
export function resolvePhiUserStateKeyOwner(
  key: string,
  activeModuleIds: readonly string[],
): string | null {
  let owner: string | null = null;
  for (const moduleId of activeModuleIds) {
    if (!key.startsWith(`${moduleId}/`) || key.length <= moduleId.length + 1) {
      continue;
    }
    if (!owner || moduleId.length > owner.length) {
      owner = moduleId;
    }
  }
  return owner;
}
