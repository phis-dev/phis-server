import type { Pool } from "pg";

import { derivePhisAddonSchemaName } from "../lib/addons/schema-name.ts";
import {
  PHIS_ADDON_OWNER_COLUMN,
  PHIS_ADDON_SITE_COLUMN,
} from "../lib/addons/schema-descriptor.ts";
import { quotePhiIdentifier } from "../lib/addons/schema-ddl.ts";
import { withPoolTransaction } from "../lib/db-transaction.ts";

/**
 * Handing an Add-on's rows from one account to another.
 *
 * The case is succession rather than sharing: one person maintains a vendor's entries, and one day it is
 * somebody else. Without this the choices are leaving the rows with an account nobody uses any more or
 * deleting them and asking the successor to type it all in again, and neither is what happened.
 *
 * **Only the owner moves.** The author stays where it is, which is what keeps a handed-over row
 * attributable afterwards -- Media's own handover keeps the same pair for the same reason. A row whose
 * owner is already null is moved too: a deleted account leaves exactly that, and it is the case most in
 * need of a successor.
 *
 * Which tables are owned is read from the catalog rather than from a manifest, and not by name: what
 * makes a table owned is that Core put an owner column on it, and that is a fact the database holds. A
 * manifest read here would be a second answer to a question the schema already answers.
 */

export type PhisAddonOwnerTransfer = {
  addonId: string;
  schemaName: string;
  siteId: number;
  fromUserId: number | null;
  toUserId: number;
  /** Per table, in the order they were touched. A table with nothing to move is reported as zero. */
  moved: { table: string; rows: number }[];
  /**
   * Owned tables that carry no Site, and are therefore not one Site's to hand over.
   *
   * Reported rather than skipped quietly: an operator who sees a transfer report with a table missing
   * from it should be told why, and the alternative -- moving them anyway -- would reach across every
   * Site from a command that named one.
   */
  skipped: string[];
  rows: number;
};

/** The tables Core put an owner on, and whether each also carries a Site. */
export async function readPhisAddonOwnedTables(pool: Pool, addonId: string) {
  const schemaName = derivePhisAddonSchemaName(addonId);
  const { rows } = await pool.query<{ table_name: string; columns: string[] }>(
    `SELECT c.table_name, ARRAY_AGG(c.column_name::text) AS columns
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = $1 AND c.column_name IN ($2, $3)
      GROUP BY c.table_name
      ORDER BY c.table_name`,
    [schemaName, PHIS_ADDON_OWNER_COLUMN, PHIS_ADDON_SITE_COLUMN],
  );
  const owned = rows.filter((row) => row.columns.includes(PHIS_ADDON_OWNER_COLUMN));
  return {
    schemaName,
    tables: owned
      .filter((row) => row.columns.includes(PHIS_ADDON_SITE_COLUMN))
      .map((row) => row.table_name),
    withoutSite: owned
      .filter((row) => !row.columns.includes(PHIS_ADDON_SITE_COLUMN))
      .map((row) => row.table_name),
  };
}

/**
 * Moves every row of one Site from one account to another, in one transaction.
 *
 * One transaction because a half-finished handover is worse than none: the successor would hold some of
 * a vendor's entries and the predecessor the rest, with nothing recording where the line was drawn.
 */
export async function transferPhisAddonOwnership(
  pool: Pool,
  input: { addonId: string; siteId: number; fromUserId: number | null; toUserId: number },
): Promise<PhisAddonOwnerTransfer> {
  const { schemaName, tables, withoutSite } = await readPhisAddonOwnedTables(pool, input.addonId);
  const moved: { table: string; rows: number }[] = [];
  await withPoolTransaction(pool, async (client) => {
    for (const table of tables) {
      const { rowCount } = await client.query(
        `UPDATE ${quotePhiIdentifier(schemaName)}.${quotePhiIdentifier(table)}
            SET ${quotePhiIdentifier(PHIS_ADDON_OWNER_COLUMN)} = $3
          WHERE ${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)} = $1
            AND ${quotePhiIdentifier(PHIS_ADDON_OWNER_COLUMN)} IS NOT DISTINCT FROM $2`,
        [input.siteId, input.fromUserId, input.toUserId],
      );
      moved.push({ table, rows: rowCount ?? 0 });
    }
  });

  return {
    addonId: input.addonId,
    schemaName,
    siteId: input.siteId,
    fromUserId: input.fromUserId,
    toUserId: input.toUserId,
    moved,
    skipped: withoutSite,
    rows: moved.reduce((total, entry) => total + entry.rows, 0),
  };
}

/** Whether an account is one of this Site's, which is what makes it eligible to receive rows. */
export async function isPhiSiteMember(pool: Pool, siteId: number, userId: number) {
  const { rows } = await pool.query(
    `SELECT 1 FROM phis.user_site_memberships WHERE site_id = $1 AND user_id = $2`,
    [siteId, userId],
  );
  return rows.length > 0;
}
