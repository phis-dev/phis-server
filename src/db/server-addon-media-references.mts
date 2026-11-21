import type { PoolClient } from "pg";

import { quotePhiIdentifier } from "../lib/addons/schema-ddl.ts";
import { PHIS_ADDON_SITE_COLUMN } from "../lib/addons/schema-descriptor.ts";

type DbQueryable = Pick<PoolClient, "query">;

/**
 * A column of an installed Add-on's table that points at `core.mediaAsset`, as its descriptor states it.
 *
 * The table is Site-scoped -- Core binds such a reference to the Site, so no other table can hold one --
 * and `primaryKey` names its row.
 */
export type PhisAddonMediaReferenceColumn = {
  addonId: string;
  packageName: string;
  schemaName: string;
  table: string;
  column: string;
  primaryKey: readonly string[];
};

/** One row of the Site that names the Asset: in which column, and the row's key. */
export type PhisAddonMediaReferenceRow = {
  source: PhisAddonMediaReferenceColumn;
  /** The row's primary key as text; a composite key's values joined by `,` in key order. */
  rowId: string;
};

/**
 * The rows of one Site that name one Media Asset in any of these columns (the Media delete guard).
 *
 * Two statements, and none at all without a column. The first asks the catalog which of the columns
 * exist: a descriptor is read from the installed manifest, and an upgrade whose migration has not run
 * yet names a table or column that is not there -- the database is what a delete would meet, so it is
 * what is asked. The second reads every existing column in one `UNION ALL`, each branch on the Site and
 * the Asset, so the cost is one statement however many Add-ons and columns there are.
 */
export async function listPhisAddonRowsReferencingMediaAsset(
  db: DbQueryable,
  input: { siteId: number; assetId: number; columns: readonly PhisAddonMediaReferenceColumn[] },
): Promise<PhisAddonMediaReferenceRow[]> {
  if (input.columns.length === 0) return [];
  const { rows: present } = await db.query<{ ord: string | number }>(
    `SELECT c.ord
       FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS c(schema_name, table_name, column_name, ord)
      WHERE EXISTS (
        SELECT 1 FROM pg_attribute a
         WHERE a.attrelid = to_regclass(format('%I.%I', c.schema_name, c.table_name))
           AND a.attname = c.column_name
           AND NOT a.attisdropped
      )
      ORDER BY c.ord`,
    [
      input.columns.map((entry) => entry.schemaName),
      input.columns.map((entry) => entry.table),
      input.columns.map((entry) => entry.column),
    ],
  );
  const existing = present.map((row) => input.columns[Number(row.ord) - 1]!);
  if (existing.length === 0) return [];

  const site = quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN);
  const branches = existing.map((entry, index) => {
    const key = entry.primaryKey.map((name) => `${quotePhiIdentifier(name)}::text`).join(", ");
    return `SELECT ${index}::int AS source, concat_ws(',', ${key}) AS row_id
       FROM ${quotePhiIdentifier(entry.schemaName)}.${quotePhiIdentifier(entry.table)}
      WHERE ${site} = $1 AND ${quotePhiIdentifier(entry.column)} = $2`;
  });
  const { rows } = await db.query<{ source: number; row_id: string }>(
    `${branches.join("\n     UNION ALL\n     ")}\n     ORDER BY source, row_id`,
    [input.siteId, input.assetId],
  );
  return rows.map((row) => ({ source: existing[row.source]!, rowId: row.row_id }));
}
