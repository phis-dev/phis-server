import type { Pool, PoolClient } from "pg";

import { PhisCdnFileOrigin } from "@phis/contracts/addon";

import {
  PHIS_CDN_LIST_LIMIT,
  PhisCdnFileFlags,
  PhisCdnUploadStatusCode,
  type PhisCdnFileRow,
} from "../lib/cdn-core.ts";

/*
 * The CDN tables -- `phis.site_cdns`, `phis.site_cdn_files` with `phis.site_cdn_file_origins`, and
 * `phis.site_cdn_uploads` -- for the Server's `cdn:v1`, `cdn-publish:v1` and CDN page, and for
 * `phis cdn`. Every function takes the pool or a transaction's client, because the CLI holds its own.
 */

type Queryable = Pick<Pool | PoolClient, "query">;

export type SiteCdnRecord = {
  siteId: number;
  storageProfileId: number;
  publicBaseUrl: string;
};

/** The Storage Profile behind a CDN, with what its probe settled (`checksum_algorithm`). */
export type SiteCdnProfileRecord = {
  id: number;
  siteId: number;
  key: string;
  providerId: string;
  config: Record<string, unknown>;
  secretReference: string | null;
  flags: number;
  checksumAlgorithm: string | null;
};

/** A file row with its origin; a row the origin sweep missed reads `origin: null`, never as the CLI's. */
const FILE_SELECT = `SELECT f.id, f.object_key, f.name, f.version, f.file_name, f.size_bytes, f.sha256, f.content_type,
            f.flags, f.published_at, o.origin, o.addon_id AS origin_addon_id,
            o.actor_user_id AS origin_actor_user_id, o.source_url
       FROM phis.site_cdn_files f
       LEFT JOIN phis.site_cdn_file_origins o ON o.file_id = f.id`;

export async function readSiteCdn(db: Queryable, siteId: number): Promise<SiteCdnRecord | null> {
  const { rows } = await db.query<{ site_id: number; storage_profile_id: number; public_base_url: string }>(
    `SELECT site_id, storage_profile_id, public_base_url FROM phis.site_cdns WHERE site_id = $1`,
    [siteId],
  );
  const row = rows[0];
  return row ? { siteId: row.site_id, storageProfileId: row.storage_profile_id, publicBaseUrl: row.public_base_url } : null;
}

export async function readSiteCdnProfile(
  db: Queryable,
  siteId: number,
  where: { id: number } | { key: string },
): Promise<SiteCdnProfileRecord | null> {
  const byId = "id" in where;
  const { rows } = await db.query<{
    id: number; site_id: number; key: string; provider_id: string; config: Record<string, unknown>;
    secret_reference: string | null; flags: number; checksum_algorithm: string | null;
  }>(
    `SELECT id, site_id, key, provider_id, config, secret_reference, flags, checksum_algorithm
       FROM phis.media_storage_profiles WHERE site_id = $1 AND ${byId ? "id = $2" : "key = $2"}`,
    [siteId, byId ? where.id : where.key],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    siteId: row.site_id,
    key: row.key,
    providerId: row.provider_id,
    config: row.config ?? {},
    secretReference: row.secret_reference,
    flags: row.flags,
    checksumAlgorithm: row.checksum_algorithm,
  };
}

/** One file by key. Withdrawn files only where asked for: an Add-on never sees them. */
export async function readSiteCdnFile(
  db: Queryable,
  siteId: number,
  key: string,
  options: { includeWithdrawn?: boolean } = {},
): Promise<PhisCdnFileRow | null> {
  const { rows } = await db.query<PhisCdnFileRow>(
    `${FILE_SELECT}
      WHERE f.site_id = $1 AND f.object_key = $2 AND ($3::boolean OR (f.flags & $4::int) = 0)`,
    [siteId, key, options.includeWithdrawn === true, PhisCdnFileFlags.Withdrawn],
  );
  return rows[0] ?? null;
}

/**
 * Ordered by name, then newest first; at most `PHIS_CDN_LIST_LIMIT` unless `all`. Copies and links alike,
 * unless `copiesOnly` -- what the bucket check compares, since a link has nothing in the bucket.
 */
export async function listSiteCdnFiles(
  db: Queryable,
  siteId: number,
  options: { name?: string | null; limit?: number; includeWithdrawn?: boolean; all?: boolean; copiesOnly?: boolean } = {},
): Promise<PhisCdnFileRow[]> {
  const limit = options.all ? null : Math.min(Math.max(1, Math.trunc(options.limit ?? PHIS_CDN_LIST_LIMIT)), PHIS_CDN_LIST_LIMIT);
  const { rows } = await db.query<PhisCdnFileRow>(
    `${FILE_SELECT}
      WHERE f.site_id = $1 AND ($2::text IS NULL OR f.name = $2) AND ($3::boolean OR (f.flags & $4::int) = 0)
        AND (NOT $6::boolean OR (f.flags & $7::int) = 0)
      ORDER BY f.name, f.published_at DESC, f.object_key
      LIMIT $5`,
    [
      siteId, options.name ?? null, options.includeWithdrawn === true, PhisCdnFileFlags.Withdrawn, limit,
      options.copiesOnly === true, PhisCdnFileFlags.Linked,
    ],
  );
  return rows;
}

export type SiteCdnAdminListQuery = {
  q: string | null;
  name: string | null;
  state: "offered" | "withdrawn" | "deleted" | "all";
  sort: "publishedAt" | "name";
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

function escapeLike(value: string) {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

/** One page of the CDN page's listing and the number of files that match, in one statement. */
export async function listSiteCdnFilesForAdmin(
  db: Queryable,
  siteId: number,
  query: SiteCdnAdminListQuery,
): Promise<{ rows: PhisCdnFileRow[]; total: number }> {
  const { Withdrawn, Deleted } = PhisCdnFileFlags;
  const state = {
    offered: `(f.flags & ${Withdrawn}) = 0`,
    withdrawn: `(f.flags & ${Withdrawn}) <> 0 AND (f.flags & ${Deleted}) = 0`,
    deleted: `(f.flags & ${Deleted}) <> 0`,
    all: "TRUE",
  }[query.state];
  const dir = query.dir === "asc" ? "ASC" : "DESC";
  const order = query.sort === "name"
    ? `m.name ${dir}, m.published_at DESC, m.object_key`
    : `m.published_at ${dir}, m.object_key`;
  const { rows } = await db.query<PhisCdnFileRow & { total: number }>(
    `WITH matched AS (
       ${FILE_SELECT}
        WHERE f.site_id = $1 AND ${state}
          AND ($2::text IS NULL OR f.name = $2)
          AND ($3::text IS NULL OR f.name ILIKE $3 ESCAPE '\\' OR f.file_name ILIKE $3 ESCAPE '\\')
     ), counted AS (SELECT COUNT(*)::int AS total FROM matched)
     SELECT c.total, m.*
       FROM counted c
       LEFT JOIN LATERAL (SELECT * FROM matched m ORDER BY ${order} LIMIT $4 OFFSET $5) m ON TRUE`,
    [
      siteId,
      query.name,
      query.q ? `%${escapeLike(query.q)}%` : null,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    ],
  );
  const total = rows[0]?.total ?? 0;
  return { rows: rows.filter((row) => row.object_key != null), total };
}

export type SiteCdnFileOriginInput = {
  origin: number;
  addonId: string | null;
  actorUserId: number | null;
  sourceUrl: string | null;
};

/**
 * Records a published file and where it came from, in one statement. False where the key was taken in
 * the meantime: a key is written once.
 */
export async function insertSiteCdnFile(db: Queryable, input: {
  siteId: number;
  key: string;
  name: string;
  version: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  /** `PhisCdnFileFlags.Linked` for a link, and the platform bits (`encodePhisCdnPlatformFlags`). */
  flags: number;
  origin: SiteCdnFileOriginInput;
}): Promise<boolean> {
  const { rowCount } = await db.query(
    `WITH inserted AS (
       INSERT INTO phis.site_cdn_files (site_id, object_key, name, version, file_name, size_bytes, sha256, content_type, flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (site_id, object_key) DO NOTHING
       RETURNING id
     )
     INSERT INTO phis.site_cdn_file_origins (file_id, origin, addon_id, actor_user_id, source_url)
     SELECT id, $10, $11, $12, $13 FROM inserted`,
    [
      input.siteId, input.key, input.name, input.version, input.fileName, input.sizeBytes, input.sha256,
      input.contentType, input.flags, input.origin.origin, input.origin.addonId, input.origin.actorUserId,
      input.origin.sourceUrl,
    ],
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

/**
 * Marks a file withdrawn and deleted. Null where it already was deleted (or does not exist), else what a
 * caller needs to give the Space its bytes back: a copy's size, and none for a link.
 */
export async function markSiteCdnFileDeleted(
  db: Queryable,
  siteId: number,
  key: string,
): Promise<{ storedBytes: number } | null> {
  const { rows } = await db.query<{ size_bytes: string; flags: number }>(
    `UPDATE phis.site_cdn_files SET flags = flags | $3::int | $4::int
      WHERE site_id = $1 AND object_key = $2 AND (flags & $4::int) = 0
      RETURNING size_bytes::text, flags`,
    [siteId, key, PhisCdnFileFlags.Withdrawn, PhisCdnFileFlags.Deleted],
  );
  const row = rows[0];
  if (!row) return null;
  return { storedBytes: (row.flags & PhisCdnFileFlags.Linked) !== 0 ? 0 : Number(row.size_bytes) };
}

/** What the Site's copied files that still have their bytes hold: what a detach gives the Site Space back. */
export async function sumSiteCdnStoredBytes(db: Queryable, siteId: number): Promise<number> {
  const { rows } = await db.query<{ bytes: string }>(
    `SELECT COALESCE(SUM(size_bytes), 0)::text AS bytes FROM phis.site_cdn_files
      WHERE site_id = $1 AND (flags & $2::int) = 0`,
    [siteId, PhisCdnFileFlags.Deleted | PhisCdnFileFlags.Linked],
  );
  return Number(rows[0]?.bytes ?? 0);
}

/**
 * Whether anybody but this Add-on holds `name`: a catalogued file of another origin (the operator's, a
 * Maintainer's upload, another Add-on's, or one without an origin row), or an open upload of one. An
 * Add-on imports and links only under a name that is new or wholly its own.
 */
export async function isSiteCdnNameHeldByOthers(db: Queryable, siteId: number, name: string, addonId: string) {
  const { rows } = await db.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM phis.site_cdn_files f
         LEFT JOIN phis.site_cdn_file_origins o ON o.file_id = f.id
        WHERE f.site_id = $1 AND f.name = $2
          AND (o.origin IS DISTINCT FROM $3::smallint OR o.addon_id IS DISTINCT FROM $4)
     ) OR EXISTS (
       SELECT 1 FROM phis.site_cdn_uploads u
        WHERE u.site_id = $1 AND u.name = $2 AND u.status < $5::smallint
          AND (u.origin <> $3::smallint OR u.addon_id IS DISTINCT FROM $4)
     ) AS held`,
    [siteId, name, PhisCdnFileOrigin.Addon, addonId, PhisCdnUploadStatusCode.Published],
  );
  return rows[0]?.held === true;
}

/* ---------------------------------------------------------------------------------------------- */
/* Uploads: a Maintainer's upload from the CDN page and an Add-on's import, one open row per key.   */
/* ---------------------------------------------------------------------------------------------- */

export type SiteCdnUploadRecord = {
  token: string;
  siteId: number;
  key: string;
  name: string;
  version: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  partSizeBytes: number;
  partSha256: string[] | null;
  expectedSha256: string | null;
  /** The platform bits the file is recorded with (`encodePhisCdnPlatformFlags`). */
  fileFlags: number;
  origin: number;
  actorUserId: number | null;
  addonId: string | null;
  sourceUrl: string | null;
  status: number;
  providerUploadId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  heartbeatAt: string | null;
  expiresAt: string;
};

type UploadRow = {
  token: string; site_id: number; object_key: string; name: string; version: string; file_name: string;
  size_bytes: string; content_type: string; part_size_bytes: string; part_sha256: string[] | null;
  expected_sha256: string | null; file_flags: number; origin: number; actor_user_id: number | null;
  addon_id: string | null; source_url: string | null; status: number; provider_upload_id: string | null;
  error_code: string | null; error_message: string | null; heartbeat_at: Date | null; expires_at: Date;
};

const UPLOAD_COLUMNS = `token, site_id, object_key, name, version, file_name, size_bytes::text, content_type,
  part_size_bytes::text, part_sha256, expected_sha256, file_flags, origin, actor_user_id, addon_id, source_url,
  status, provider_upload_id, error_code, error_message, heartbeat_at, expires_at`;

function mapUpload(row: UploadRow): SiteCdnUploadRecord {
  return {
    token: row.token,
    siteId: row.site_id,
    key: row.object_key,
    name: row.name,
    version: row.version,
    fileName: row.file_name,
    sizeBytes: Number(row.size_bytes),
    contentType: row.content_type,
    partSizeBytes: Number(row.part_size_bytes),
    partSha256: row.part_sha256,
    expectedSha256: row.expected_sha256,
    fileFlags: row.file_flags,
    origin: row.origin,
    actorUserId: row.actor_user_id,
    addonId: row.addon_id,
    sourceUrl: row.source_url,
    status: row.status,
    providerUploadId: row.provider_upload_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/**
 * Opens an upload. Null where one of the same key is open already: the partial unique index on open
 * rows is the lock, so two Maintainers, or a Maintainer and an Add-on, never write one key at once.
 */
export async function insertSiteCdnUpload(db: Queryable, input: {
  token: string;
  siteId: number;
  key: string;
  name: string;
  version: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  partSizeBytes: number;
  partSha256: string[] | null;
  expectedSha256: string | null;
  fileFlags: number;
  origin: number;
  actorUserId: number | null;
  addonId: string | null;
  sourceUrl: string | null;
  providerUploadId: string | null;
  ttlMs: number;
}): Promise<SiteCdnUploadRecord | null> {
  const { rows } = await db.query<UploadRow>(
    `INSERT INTO phis.site_cdn_uploads (token, site_id, object_key, name, version, file_name, size_bytes, content_type,
       part_size_bytes, part_sha256, expected_sha256, file_flags, origin, actor_user_id, addon_id, source_url, status,
       provider_upload_id, heartbeat_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, NOW(),
       NOW() + MAKE_INTERVAL(secs => $19::float8 / 1000))
     ON CONFLICT (site_id, object_key) WHERE status < ${PhisCdnUploadStatusCode.Published} DO NOTHING
     RETURNING ${UPLOAD_COLUMNS}`,
    [
      input.token, input.siteId, input.key, input.name, input.version, input.fileName, input.sizeBytes,
      input.contentType, input.partSizeBytes, input.partSha256 ? JSON.stringify(input.partSha256) : null,
      input.expectedSha256, input.fileFlags, input.origin, input.actorUserId, input.addonId, input.sourceUrl,
      PhisCdnUploadStatusCode.Pending, input.providerUploadId, input.ttlMs,
    ],
  );
  return rows[0] ? mapUpload(rows[0]) : null;
}

/** Sets the Provider's name for the assembly once the plan exists. */
export async function setSiteCdnUploadProviderId(db: Queryable, token: string, providerUploadId: string) {
  await db.query(
    `UPDATE phis.site_cdn_uploads SET provider_upload_id = $2, updated_at = NOW() WHERE token = $1`,
    [token, providerUploadId],
  );
}

export async function readSiteCdnUpload(db: Queryable, token: string): Promise<SiteCdnUploadRecord | null> {
  const { rows } = await db.query<UploadRow>(`SELECT ${UPLOAD_COLUMNS} FROM phis.site_cdn_uploads WHERE token = $1`, [token]);
  return rows[0] ? mapUpload(rows[0]) : null;
}

/** The open upload of a key, if any. */
export async function readOpenSiteCdnUpload(db: Queryable, siteId: number, key: string): Promise<SiteCdnUploadRecord | null> {
  const { rows } = await db.query<UploadRow>(
    `SELECT ${UPLOAD_COLUMNS} FROM phis.site_cdn_uploads
      WHERE site_id = $1 AND object_key = $2 AND status < ${PhisCdnUploadStatusCode.Published}`,
    [siteId, key],
  );
  return rows[0] ? mapUpload(rows[0]) : null;
}

/** Whether the Site has any open upload: a detach waits for them. */
export async function hasOpenSiteCdnUploads(db: Queryable, siteId: number) {
  const { rows } = await db.query<{ open: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM phis.site_cdn_uploads WHERE site_id = $1 AND status < $2::smallint) AS open`,
    [siteId, PhisCdnUploadStatusCode.Published],
  );
  return rows[0]?.open === true;
}

/**
 * Says an open upload is still being sent, and pushes its expiry `ttlMs` ahead; a pending one becomes
 * `uploading`. False where it is not open (any more).
 */
export async function renewSiteCdnUpload(db: Queryable, token: string, ttlMs: number) {
  const { rowCount } = await db.query(
    `UPDATE phis.site_cdn_uploads
        SET heartbeat_at = NOW(), expires_at = NOW() + MAKE_INTERVAL(secs => $2::float8 / 1000), updated_at = NOW(),
            status = CASE WHEN status = $3::smallint THEN $4::smallint ELSE status END
      WHERE token = $1 AND status IN ($3::smallint, $4::smallint)`,
    [token, ttlMs, PhisCdnUploadStatusCode.Pending, PhisCdnUploadStatusCode.Uploading],
  );
  return rowCount === 1;
}

/** Moves a pending or uploading upload to `hashing`. False where it was not in either. */
export async function startSiteCdnUploadHashing(db: Queryable, token: string) {
  const { rowCount } = await db.query(
    `UPDATE phis.site_cdn_uploads SET status = $2::smallint, heartbeat_at = NOW(), updated_at = NOW()
      WHERE token = $1 AND status IN ($3::smallint, $4::smallint)`,
    [token, PhisCdnUploadStatusCode.Hashing, PhisCdnUploadStatusCode.Pending, PhisCdnUploadStatusCode.Uploading],
  );
  return rowCount === 1;
}

/** Says the hashing of an upload is alive, so the prune job does not take it over. */
export async function beatSiteCdnUploadHashing(db: Queryable, token: string) {
  await db.query(
    `UPDATE phis.site_cdn_uploads SET heartbeat_at = NOW(), updated_at = NOW() WHERE token = $1 AND status = $2::smallint`,
    [token, PhisCdnUploadStatusCode.Hashing],
  );
}

/**
 * Takes over a `hashing` upload whose heartbeat stopped -- the instance doing it died. Only one caller
 * wins, because the claim renews the heartbeat it is conditioned on.
 */
export async function claimStaleSiteCdnUploadHashing(db: Queryable, lapseMs: number, limit: number): Promise<SiteCdnUploadRecord[]> {
  const { rows } = await db.query<UploadRow>(
    `UPDATE phis.site_cdn_uploads SET heartbeat_at = NOW(), updated_at = NOW()
      WHERE token IN (
        SELECT token FROM phis.site_cdn_uploads
         WHERE status = $1::smallint
           AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - MAKE_INTERVAL(secs => $2::float8 / 1000))
         ORDER BY heartbeat_at NULLS FIRST
         LIMIT $3::int
         FOR UPDATE SKIP LOCKED)
      RETURNING ${UPLOAD_COLUMNS}`,
    [PhisCdnUploadStatusCode.Hashing, lapseMs, limit],
  );
  return rows.map(mapUpload);
}

/**
 * Ends an upload as `published`, `failed` or `aborted`. Null where it had ended already, so whoever gets
 * the row is the one caller that gives its reservation back (or commits it).
 */
export async function endSiteCdnUpload(
  db: Queryable,
  token: string,
  status: number,
  error: { code: string; message: string } | null = null,
  options: { from?: readonly number[] } = {},
): Promise<SiteCdnUploadRecord | null> {
  const from = options.from ?? [PhisCdnUploadStatusCode.Pending, PhisCdnUploadStatusCode.Uploading, PhisCdnUploadStatusCode.Hashing];
  const { rows } = await db.query<UploadRow>(
    `UPDATE phis.site_cdn_uploads
        SET status = $2::smallint, error_code = $3, error_message = $4, updated_at = NOW()
      WHERE token = $1 AND status = ANY($5::smallint[])
      RETURNING ${UPLOAD_COLUMNS}`,
    [token, status, error?.code ?? null, error ? error.message.slice(0, 1000) : null, from],
  );
  return rows[0] ? mapUpload(rows[0]) : null;
}

/** Open uploads whose expiry passed: no heartbeat, part or import kept them alive. Oldest first. */
export async function listExpiredSiteCdnUploads(db: Queryable, limit: number): Promise<SiteCdnUploadRecord[]> {
  const { rows } = await db.query<UploadRow>(
    `SELECT ${UPLOAD_COLUMNS} FROM phis.site_cdn_uploads
      WHERE status IN ($1::smallint, $2::smallint) AND expires_at < NOW()
      ORDER BY expires_at LIMIT $3::int`,
    [PhisCdnUploadStatusCode.Pending, PhisCdnUploadStatusCode.Uploading, limit],
  );
  return rows.map(mapUpload);
}

/** Forgets ended uploads older than `olderThanMs`; the catalogue keeps what was published. */
export async function forgetEndedSiteCdnUploads(db: Queryable, olderThanMs: number, limit: number) {
  const { rowCount } = await db.query(
    `DELETE FROM phis.site_cdn_uploads
      WHERE token IN (
        SELECT token FROM phis.site_cdn_uploads
         WHERE status >= $1::smallint AND updated_at < NOW() - MAKE_INTERVAL(secs => $2::float8 / 1000)
         ORDER BY updated_at LIMIT $3::int
         FOR UPDATE SKIP LOCKED)`,
    [PhisCdnUploadStatusCode.Published, olderThanMs, limit],
  );
  return rowCount ?? 0;
}

/** Counts for `phis maintain --task cdn-uploads --dry-run`. */
export async function countSiteCdnUploadMaintenance(db: Queryable, lapseMs: number, olderThanMs: number) {
  const { rows } = await db.query<{ expired: number; stale: number; ended: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ($1::smallint, $2::smallint) AND expires_at < NOW())::int AS expired,
       COUNT(*) FILTER (WHERE status = $3::smallint
         AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - MAKE_INTERVAL(secs => $4::float8 / 1000)))::int AS stale,
       COUNT(*) FILTER (WHERE status >= $5::smallint
         AND updated_at < NOW() - MAKE_INTERVAL(secs => $6::float8 / 1000))::int AS ended
     FROM phis.site_cdn_uploads`,
    [
      PhisCdnUploadStatusCode.Pending, PhisCdnUploadStatusCode.Uploading, PhisCdnUploadStatusCode.Hashing, lapseMs,
      PhisCdnUploadStatusCode.Published, olderThanMs,
    ],
  );
  return rows[0] ?? { expired: 0, stale: 0, ended: 0 };
}

/** A Site's key, for the prune job that walks uploads of every Site. */
export async function readSiteKey(db: Queryable, siteId: number): Promise<string | null> {
  const { rows } = await db.query<{ key: string }>(`SELECT key FROM phis.sites WHERE id = $1`, [siteId]);
  return rows[0]?.key ?? null;
}
