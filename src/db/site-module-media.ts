import "server-only";

import type { PoolClient } from "pg";

import { withTransaction } from "@/lib/db";
import { PhisSiteModuleMediaFlag } from "@/lib/constants/media";

/**
 * Which Asset or Media Folder of a Site stands for a name a Module package declares
 * (design/MODULE_MEDIA.md, DB.md `site_module_media` and `site_module_media_folders`).
 *
 * Everything that changes these rows holds `withSiteModuleMediaLock`: the import, a hand binding and a
 * reset all read a row, decide, and write it, and two of them on one name would write one name twice.
 * The lock is per Site and ends with the transaction, so there is nothing to release and nothing a
 * crashed request can leave held.
 */

type DbQueryable = Pick<PoolClient, "query">;

export type SiteModuleMediaFileRow = {
  packageName: string;
  key: string;
  assetId: number | null;
  sourceChecksum: string | null;
  flags: number;
  /** The digest the target Asset carries, when it carries a SHA-256; null where the Asset is gone. */
  assetChecksum: string | null;
  updatedAt: string;
};

export type SiteModuleMediaFolderRow = {
  packageName: string;
  key: string;
  folderId: number | null;
  flags: number;
  updatedAt: string;
};

export function isSiteModuleMediaBound(row: { flags: number }) {
  return (row.flags & PhisSiteModuleMediaFlag.Bound) !== 0;
}

/** Serialises the writers of one Site's Module media rows until the transaction ends. */
export async function withSiteModuleMediaLock<T>(siteId: number, body: (db: PoolClient) => Promise<T>) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`phis.site_module_media:${siteId}`]);
    return body(client);
  });
}

type FileRowSql = {
  package_name: string;
  key: string;
  asset_id: number | null;
  source_checksum: string | null;
  flags: number;
  asset_checksum: string | null;
  updated_at: Date | string;
};

const FILE_SELECT = `SELECT m.package_name, m.key, m.asset_id, m.source_checksum, m.flags,
         CASE WHEN a.checksum_algorithm = 'sha256' THEN a.checksum_value END AS asset_checksum, m.updated_at
    FROM phis.site_module_media m
    LEFT JOIN phis.media_assets a ON a.id = m.asset_id AND a.site_id = m.site_id`;

function mapFile(row: FileRowSql): SiteModuleMediaFileRow {
  return {
    packageName: row.package_name,
    key: row.key,
    assetId: row.asset_id,
    sourceChecksum: row.source_checksum,
    flags: row.flags,
    assetChecksum: row.asset_checksum,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function mapFolder(row: { package_name: string; key: string; folder_id: number | null; flags: number; updated_at: Date | string }): SiteModuleMediaFolderRow {
  return {
    packageName: row.package_name,
    key: row.key,
    folderId: row.folder_id,
    flags: row.flags,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export async function listSiteModuleMediaFiles(db: DbQueryable, siteId: number) {
  const { rows } = await db.query<FileRowSql>(`${FILE_SELECT} WHERE m.site_id = $1 ORDER BY m.package_name, m.key`, [siteId]);
  return rows.map(mapFile);
}

export async function listSiteModuleMediaFolders(db: DbQueryable, siteId: number) {
  const { rows } = await db.query(
    `SELECT package_name, key, folder_id, flags, updated_at FROM phis.site_module_media_folders
      WHERE site_id = $1 ORDER BY package_name, key`,
    [siteId],
  );
  return rows.map(mapFolder);
}

export async function getSiteModuleMediaFile(db: DbQueryable, siteId: number, packageName: string, key: string) {
  const { rows } = await db.query<FileRowSql>(
    `${FILE_SELECT} WHERE m.site_id = $1 AND m.package_name = $2 AND m.key = $3`,
    [siteId, packageName, key],
  );
  return rows[0] ? mapFile(rows[0]) : null;
}

export async function getSiteModuleMediaFolder(db: DbQueryable, siteId: number, packageName: string, key: string) {
  const { rows } = await db.query(
    `SELECT package_name, key, folder_id, flags, updated_at FROM phis.site_module_media_folders
      WHERE site_id = $1 AND package_name = $2 AND key = $3`,
    [siteId, packageName, key],
  );
  return rows[0] ? mapFolder(rows[0]) : null;
}

/** Writes the whole row; the caller states the flags, so a Bound row is never cleared by accident. */
export async function writeSiteModuleMediaFile(db: DbQueryable, input: {
  siteId: number; packageName: string; key: string; assetId: number | null; sourceChecksum: string | null; flags: number;
}) {
  await db.query(
    `INSERT INTO phis.site_module_media (site_id, package_name, key, asset_id, source_checksum, flags)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (site_id, package_name, key)
     DO UPDATE SET asset_id = EXCLUDED.asset_id, source_checksum = EXCLUDED.source_checksum,
                   flags = EXCLUDED.flags, updated_at = NOW()`,
    [input.siteId, input.packageName, input.key, input.assetId, input.sourceChecksum, input.flags],
  );
}

export async function writeSiteModuleMediaFolder(db: DbQueryable, input: {
  siteId: number; packageName: string; key: string; folderId: number | null; flags: number;
}) {
  await db.query(
    `INSERT INTO phis.site_module_media_folders (site_id, package_name, key, folder_id, flags)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id, package_name, key)
     DO UPDATE SET folder_id = EXCLUDED.folder_id, flags = EXCLUDED.flags, updated_at = NOW()`,
    [input.siteId, input.packageName, input.key, input.folderId, input.flags],
  );
}

export async function deleteSiteModuleMediaFile(db: DbQueryable, siteId: number, packageName: string, key: string) {
  const result = await db.query(
    `DELETE FROM phis.site_module_media WHERE site_id = $1 AND package_name = $2 AND key = $3`,
    [siteId, packageName, key],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteSiteModuleMediaFolder(db: DbQueryable, siteId: number, packageName: string, key: string) {
  const result = await db.query(
    `DELETE FROM phis.site_module_media_folders WHERE site_id = $1 AND package_name = $2 AND key = $3`,
    [siteId, packageName, key],
  );
  return (result.rowCount ?? 0) > 0;
}

/** An Asset of this Site that lies in the given Space, which is all a hand binding needs to know. */
export async function siteSpaceHoldsAsset(db: DbQueryable, siteId: number, spaceId: number, assetId: number) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM phis.media_assets WHERE id = $1 AND site_id = $2 AND space_id = $3`,
    [assetId, siteId, spaceId],
  );
  return (rowCount ?? 0) > 0;
}

export async function siteSpaceHoldsFolder(db: DbQueryable, siteId: number, spaceId: number, folderId: number) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM phis.media_folders WHERE id = $1 AND site_id = $2 AND space_id = $3`,
    [folderId, siteId, spaceId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The Folder of that name under that parent, as the unique index reads it (case-insensitive), or null.
 * The import binds to such a Folder rather than refusing or making a second one.
 */
export async function findMediaFolderByName(db: DbQueryable, input: {
  siteId: number; spaceId: number; parentId: number | null; name: string;
}) {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM phis.media_folders
      WHERE site_id = $1 AND space_id = $2 AND COALESCE(parent_id, 0) = COALESCE($3, 0) AND LOWER(name) = LOWER($4)`,
    [input.siteId, input.spaceId, input.parentId, input.name],
  );
  return rows[0]?.id ?? null;
}

export async function insertMediaFolder(db: DbQueryable, input: {
  siteId: number; spaceId: number; parentId: number | null; name: string;
}) {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO phis.media_folders (site_id, space_id, parent_id, name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.siteId, input.spaceId, input.parentId, input.name],
  );
  return rows[0]!.id;
}

/**
 * Moves reserved bytes to used, for a write that reserved them in the same transaction -- the commit an
 * upload session does, without the session. Throws where the reservation is not there to move.
 */
export async function commitMediaSpaceBytes(db: DbQueryable, input: { spaceId: number; bytes: number }) {
  const { rowCount } = await db.query(
    `UPDATE phis.media_spaces
        SET reserved_bytes = GREATEST(0, reserved_bytes - $2), used_bytes = used_bytes + $2, updated_at = NOW()
      WHERE id = $1 AND reserved_bytes >= $2`,
    [input.spaceId, input.bytes],
  );
  if ((rowCount ?? 0) === 0) throw new Error("Media Space quota reservation is no longer available.");
}
