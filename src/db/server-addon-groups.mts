import type { Pool, PoolClient } from "pg";

import type { PhiServerAddonGroupDescriptor } from "../lib/addons/contract.ts";

/**
 * The groups an Add-on declared, on one Site.
 *
 * They live in `phis.site_groups` beside Core's own, told apart by `provider_id` rather than by a table
 * of their own. That is what makes them work everywhere without a second mechanism: the ladder, the
 * membership projection and the Site's group administration all read one table, and an Add-on's group
 * is a group like any other. Core already filters group claims against the available providers, so one
 * belonging to a removed Add-on stops granting anything on its own.
 *
 * Creation is idempotent, and removal is retirement rather than deletion. A retired group grants
 * nothing, but its key and its members stay -- so re-enabling an Add-on does not mean re-entering
 * everybody who was in it.
 */

type Queryable = Pick<Pool | PoolClient, "query">;

export type PhiServerAddonGroupAction = {
  key: string;
  groupId: number;
  action: "created" | "present" | "restored" | "retired";
};

export async function ensurePhiServerAddonSiteGroups(
  db: Queryable,
  input: { addonId: string; siteId: number; declared: PhiServerAddonGroupDescriptor[] },
): Promise<PhiServerAddonGroupAction[]> {
  const actions: PhiServerAddonGroupAction[] = [];
  for (const group of input.declared) {
    /*
     * Harmless to run twice, which it has to be: enabling a Site runs it, and so does reconciling a
     * release whose manifest declares a group that did not exist before.
     *
     * A retired group comes back rather than staying dead -- retirement is what removal does, so a
     * group declared again is one somebody asked for again. It is read before the upsert because
     * RETURNING reports the row as it now is, and what is worth telling an operator is what it was.
     */
    const { rows: before } = await db.query<{ retired_at: string | null }>(
      `SELECT retired_at FROM phis.site_groups
        WHERE site_id = $1 AND provider_id = $2 AND key = $3`,
      [input.siteId, input.addonId, group.key],
    );
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO phis.site_groups (site_id, provider_id, key, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (site_id, provider_id, key) DO UPDATE
         SET name = EXCLUDED.name,
             retired_at = NULL,
             updated_at = NOW()
       RETURNING id`,
      [input.siteId, input.addonId, group.key, group.name],
    );
    const existing = before[0];
    actions.push({
      key: group.key,
      groupId: rows[0]!.id,
      action: !existing ? "created" : existing.retired_at ? "restored" : "present",
    });
  }
  return actions;
}

export async function retirePhiServerAddonSiteGroups(
  db: Queryable,
  input: { addonId: string; siteId?: number },
): Promise<PhiServerAddonGroupAction[]> {
  const { rows } = await db.query<{ id: number; key: string }>(
    input.siteId === undefined
      ? `UPDATE phis.site_groups SET retired_at = NOW(), updated_at = NOW()
          WHERE provider_id = $1 AND retired_at IS NULL
         RETURNING id, key`
      : `UPDATE phis.site_groups SET retired_at = NOW(), updated_at = NOW()
          WHERE provider_id = $1 AND site_id = $2 AND retired_at IS NULL
         RETURNING id, key`,
    input.siteId === undefined ? [input.addonId] : [input.addonId, input.siteId],
  );
  return rows.map((row) => ({ key: row.key, groupId: row.id, action: "retired" as const }));
}

/** What one Add-on's groups are on one Site, for the capability that hands ids to a handler. */
export async function readPhiServerAddonSiteGroups(
  db: Queryable,
  input: { addonId: string; siteId: number },
) {
  const { rows } = await db.query<{ id: number; key: string; name: string }>(
    `SELECT id, key, name FROM phis.site_groups
      WHERE provider_id = $1 AND site_id = $2 AND retired_at IS NULL
      ORDER BY key`,
    [input.addonId, input.siteId],
  );
  return rows;
}
