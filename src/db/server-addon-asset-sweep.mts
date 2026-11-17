import type { Pool } from "pg";

import { quotePhiIdentifier } from "../lib/addons/schema-ddl.ts";
import { derivePhisAddonSchemaName } from "../lib/addons/schema-name.ts";
import { PhisMediaSpaceKind } from "../lib/constants/media-space-kinds.ts";

/**
 * Collecting the files of an Add-on that nothing points at any more.
 *
 * The orphan has changed shape, and become much easier to find. While an Add-on's assets were objects
 * under a prefix of their own, finding the unreferenced ones meant listing a bucket and subtracting --
 * an unbounded operation, and one that could only ever look at objects Core had put there itself.
 *
 * Now a file is a Media Asset in the Add-on's own Space, and the Add-on's table holds a link to it. So
 * the question is a join: which Assets in that Space does no link name. No listing, no prefix, no
 * bucket. Removing them is Media's ordinary deletion, which takes the object and the Space's figures
 * along.
 *
 * They arise because the cascade only runs one way. Removing an Add-on's parent row takes its link rows
 * with it -- that is the foreign key doing its job -- but a Media Asset is not the Add-on's to cascade,
 * and nothing in SQL was going to reach into a store anyway. So the file outlives the link by design,
 * and this is where it is caught up with.
 */

/**
 * The tables Core added beside the ones that declare assets.
 *
 * Read from the catalog rather than from the manifest, and not by name: a declared table may
 * legitimately be called `foo_assets` where `foo` declares nothing. What marks a derived one is that it
 * holds `media_asset_id` and `slot` together, which no descriptor can produce -- the columns are Core's.
 */
export async function readPhisAddonAssetTables(pool: Pool, addonId: string) {
  const schemaName = derivePhisAddonSchemaName(addonId);
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND column_name IN ('media_asset_id', 'slot')
      GROUP BY table_name
     HAVING COUNT(DISTINCT column_name) = 2
      ORDER BY table_name`,
    [schemaName],
  );
  return { schemaName, tables: rows.map((row) => row.table_name) };
}

export type PhisAddonSweepResult = {
  siteKey: string;
  /** Media Assets in the Add-on's Space that no link row names. */
  orphaned: number;
  /** Reservations that ran out before they were redeemed. */
  expired: number;
  bytesReleased: number;
  /**
   * The objects those rows named, for the caller to remove.
   *
   * Reported rather than removed here, for the reason the purge reports too: this module talks to the
   * database and the store is somewhere else entirely. Rows first and objects second is also the order
   * that cannot lose anything -- what a failed removal leaves is an object nobody names, which is
   * exactly what the next sweep is looking for.
   */
  storageKeys: string[];
};

/**
 * Everything the Add-on's Space holds that nothing refers to, on one Site.
 *
 * Expired reservations are swept here too, and by the same statement Media uses for its own: a session
 * past its expiry is dead whoever was holding it, so any instance may remove it. What that leaves is the
 * staged object, which becomes an orphan in the first sense and is collected by the same pass.
 */
export async function sweepPhisAddonAssets(
  pool: Pool,
  input: {
    addonId: string;
    siteId: number;
    siteKey: string;
  },
): Promise<PhisAddonSweepResult> {
  const { addonId, siteId, siteKey } = input;
  const result: PhisAddonSweepResult = {
    siteKey, orphaned: 0, expired: 0, bytesReleased: 0, storageKeys: [],
  };

  const { rows: spaces } = await pool.query<{ id: number }>(
    `SELECT id FROM phis.media_spaces WHERE site_id = $1 AND kind = $3 AND addon_id = $2`,
    [siteId, addonId, PhisMediaSpaceKind.Addon],
  );
  const spaceId = spaces[0]?.id;
  if (spaceId == null) {
    return result;
  }

  /*
   * Reservations first, and their staged objects with them.
   *
   * An expired session is dead whoever was holding it, so any instance may remove one -- there is no
   * in-flight transfer a lapsed expiry could belong to. Removing it gives its reservation back in the
   * same statement, the way Media's own release does.
   */
  const { rows: expired } = await pool.query<{ staging_storage_key: string }>(
    `WITH gone AS (
       DELETE FROM phis.media_upload_sessions
        WHERE space_id = $1 AND expires_at < NOW()
        RETURNING size_bytes, staging_storage_key
     ), freed AS (
       SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes FROM gone
     ), released AS (
       UPDATE phis.media_spaces s
          SET reserved_bytes = GREATEST(0, s.reserved_bytes - f.bytes), updated_at = NOW()
         FROM freed f WHERE s.id = $1
       RETURNING s.id
     )
     SELECT staging_storage_key FROM gone`,
    [spaceId],
  );
  result.expired = expired.length;
  result.storageKeys.push(...expired.map((row) => row.staging_storage_key));

  const { schemaName, tables } = await readPhisAddonAssetTables(pool, addonId);
  /*
   * No catalog, no judgement. An orphan is an Asset no link row names, and that is only decidable
   * against the link tables; where the schema holds none -- not applied yet, or a version that
   * declares no slots -- the pass has nothing to compare against. It used to drop the filter in that
   * case and delete every Asset in the Space: a sweep run between `addon upgrade` and `addon migrate`
   * would have emptied a store whose files were all still referenced.
   */
  if (tables.length === 0) {
    return result;
  }
  const linked = tables
    .map((table) => (
      `SELECT media_asset_id FROM ${quotePhiIdentifier(schemaName)}.${quotePhiIdentifier(table)}`
    ))
    .join(" UNION ALL ");

  const { rows: orphans } = await pool.query<{ bytes: string | null; storage_key: string }>(
    `WITH gone AS (
       DELETE FROM phis.media_assets a
        WHERE a.site_id = $1 AND a.space_id = $2
          AND a.id NOT IN (${linked})
          -- A file a message carries is not an orphan: the attachment's foreign key would refuse this
          -- delete, and the whole pass with it. It goes once no message names it any more.
          AND NOT EXISTS (SELECT 1 FROM phis.thread_message_assets t WHERE t.asset_id = a.id)
        RETURNING a.bytes, a.storage_key
     ), freed AS (
       SELECT COALESCE(SUM(bytes), 0)::bigint AS bytes FROM gone
     ), released AS (
       UPDATE phis.media_spaces s
          SET used_bytes = GREATEST(0, s.used_bytes - f.bytes), updated_at = NOW()
         FROM freed f WHERE s.id = $2
       RETURNING s.id
     )
     SELECT bytes, storage_key FROM gone`,
    [siteId, spaceId],
  );
  result.orphaned = orphans.length;
  result.bytesReleased = orphans.reduce((total, row) => total + Number(row.bytes ?? 0), 0);
  result.storageKeys.push(...orphans.map((row) => row.storage_key));
  return result;
}
