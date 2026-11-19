import type { Pool, PoolClient } from "pg";

import { PHIS_CDN_LIST_LIMIT, PhisCdnFileFlags, type PhisCdnFileRow } from "../lib/cdn-core.ts";

/*
 * The CDN tables, `phis.site_cdns` and `phis.site_cdn_files`, for the Server's `cdn:v1` and for
 * `phis cdn`. Every function takes the pool, because the CLI holds its own.
 */

type Queryable = Pick<Pool | PoolClient, "query">;

export type SiteCdnRecord = {
  siteId: number;
  storageProfileId: number;
  publicBaseUrl: string;
};

const FILE_COLUMNS = `object_key, name, version, file_name, size_bytes, sha256, content_type, flags, published_at`;

export async function readSiteCdn(db: Queryable, siteId: number): Promise<SiteCdnRecord | null> {
  const { rows } = await db.query<{ site_id: number; storage_profile_id: number; public_base_url: string }>(
    `SELECT site_id, storage_profile_id, public_base_url FROM phis.site_cdns WHERE site_id = $1`,
    [siteId],
  );
  const row = rows[0];
  return row ? { siteId: row.site_id, storageProfileId: row.storage_profile_id, publicBaseUrl: row.public_base_url } : null;
}

/** One file by key. Withdrawn files only where asked for: an Add-on never sees them. */
export async function readSiteCdnFile(
  db: Queryable,
  siteId: number,
  key: string,
  options: { includeWithdrawn?: boolean } = {},
): Promise<PhisCdnFileRow | null> {
  const { rows } = await db.query<PhisCdnFileRow>(
    `SELECT ${FILE_COLUMNS} FROM phis.site_cdn_files
      WHERE site_id = $1 AND object_key = $2 AND ($3::boolean OR (flags & $4::int) = 0)`,
    [siteId, key, options.includeWithdrawn === true, PhisCdnFileFlags.Withdrawn],
  );
  return rows[0] ?? null;
}

/** Ordered by name, then newest first; at most `PHIS_CDN_LIST_LIMIT` unless `all`. */
export async function listSiteCdnFiles(
  db: Queryable,
  siteId: number,
  options: { name?: string | null; limit?: number; includeWithdrawn?: boolean; all?: boolean } = {},
): Promise<PhisCdnFileRow[]> {
  const limit = options.all ? null : Math.min(Math.max(1, Math.trunc(options.limit ?? PHIS_CDN_LIST_LIMIT)), PHIS_CDN_LIST_LIMIT);
  const { rows } = await db.query<PhisCdnFileRow>(
    `SELECT ${FILE_COLUMNS} FROM phis.site_cdn_files
      WHERE site_id = $1 AND ($2::text IS NULL OR name = $2) AND ($3::boolean OR (flags & $4::int) = 0)
      ORDER BY name, published_at DESC, object_key
      LIMIT $5`,
    [siteId, options.name ?? null, options.includeWithdrawn === true, PhisCdnFileFlags.Withdrawn, limit],
  );
  return rows;
}

/** Records a published file. False where the key was taken in the meantime: a key is written once. */
export async function insertSiteCdnFile(db: Queryable, input: {
  siteId: number;
  key: string;
  name: string;
  version: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
}): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO phis.site_cdn_files (site_id, object_key, name, version, file_name, size_bytes, sha256, content_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (site_id, object_key) DO NOTHING`,
    [input.siteId, input.key, input.name, input.version, input.fileName, input.sizeBytes, input.sha256, input.contentType],
  );
  return rowCount === 1;
}

/** Marks a file withdrawn. False where there is no such file or it already was. */
export async function withdrawSiteCdnFile(db: Queryable, siteId: number, key: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE phis.site_cdn_files SET flags = flags | $3::int
      WHERE site_id = $1 AND object_key = $2 AND (flags & $3::int) = 0`,
    [siteId, key, PhisCdnFileFlags.Withdrawn],
  );
  return rowCount === 1;
}
