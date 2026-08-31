import "server-only";

import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";
import {
  PhiMediaDeliveryPolicy,
  PhiMediaLifecycleStatus,
  PhiMediaSpaceKind,
  type MediaSpaceRecord,
  type MediaStorageProfileRecord,
} from "@/db/media-spaces";

type DbQueryable = Pick<PoolClient, "query">;

function integer(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return Number.parseInt(value, 10) || 0;
  return 0;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeFolderPathSegment(value: string) {
  return value.replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
}

export function normalizeMediaFolderPath(value: unknown) {
  if (!Array.isArray(value)) return null;
  const path = value.map((part) => typeof part === "string" ? normalizeFolderPathSegment(part) : "").filter(Boolean);
  return path.length === value.length ? path : null;
}

export type MediaFocalRectRecord = { x: number; y: number; width: number; height: number };

export function normalizeMediaFocalRect(value: unknown): MediaFocalRectRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const values = [source.x, source.y, source.width, source.height];
  if (!values.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0 && part <= 1)) {
    return null;
  }
  const [x, y, width, height] = values as number[];
  if (width <= 0 || height <= 0 || x >= 1 || y >= 1) return null;
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}

export type MediaFolderRecord = {
  id: number;
  siteId: number;
  spaceId: number;
  parentId: number | null;
  name: string;
  sortOrder: number;
  flags: number;
  createdAt: string;
  updatedAt: string;
};

export type MediaAssetRecord = {
  id: number;
  siteId: number;
  spaceId: number;
  folderId: number | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  /** Who may act on it now, which is not necessarily who brought it in. */
  ownerUserId: number | null;
  storageProfileId: number;
  storageKey: string;
  originalName: string;
  contentType: string;
  variantVersion: number | null;
  bytes: number | null;
  checksumSha256: string | null;
  width: number | null;
  height: number | null;
  blurDataUrl: string | null;
  meta: Record<string, unknown> | null;
  title: string | null;
  altText: string | null;
  lifecycleStatus: number;
  deliveryPolicy: number;
  deliveryRevision: number;
  presentationFlags: number;
  createdAt: string;
  updatedAt: string;
};

export type ImageAssetVariantRecord = {
  assetId: number;
  variantKey: number;
  storageProfileId: number;
  storageKey: string;
  contentType: string;
  bytes: number | null;
  checksumSha256: string | null;
  width: number;
  height: number;
  blurDataUrl: string | null;
  flags: number;
  createdAt: string;
  updatedAt: string;
};

export type MediaUploadSessionRecord = {
  token: string;
  siteId: number;
  actorUserId: number;
  spaceId: number;
  folderId: number | null;
  storageProfileId: number;
  status: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  kind: string;
  uploadPlanKind: number;
  checksumSha256: string | null;
  meta: Record<string, unknown> | null;
  presentationFlags: number;
  stagingStorageKey: string;
  finalStorageKey: string | null;
  expiresAt: string;
  uploadedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ListMediaAssetsFilters = {
  spaceId: number;
  id?: number | null;
  folderId?: number | null;
  folderIds?: number[] | null;
  query?: string | null;
  kinds?: string[] | null;
  contentType?: string | null;
  presentationFlags?: number | null;
  since?: string | null;
  until?: string | null;
  sort?: "created_at_desc" | null;
  limit?: number | null;
  offset?: number | null;
};

type FolderRow = {
  id: number; site_id: number; space_id: number; parent_id: number | null; name: string;
  sort_order: number; flags: number; created_at: Date | string; updated_at: Date | string;
};

function mapFolder(row: FolderRow): MediaFolderRecord {
  return {
    id: integer(row.id), siteId: integer(row.site_id), spaceId: integer(row.space_id),
    parentId: row.parent_id == null ? null : integer(row.parent_id), name: row.name,
    sortOrder: integer(row.sort_order), flags: integer(row.flags), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

type AssetRow = {
  id: number; site_id: number; space_id: number; folder_id: number | null;
  created_by_user_id: number | null; updated_by_user_id: number | null; owner_user_id: number | null;
  storage_profile_id: number;
  storage_key: string; original_name: string; content_type: string; variant_version: number | null;
  bytes: number | string | null; checksum_sha256: string | null; width: number | null; height: number | null;
  blur_data_url: string | null; meta: unknown; title: string | null; alt_text: string | null;
  lifecycle_status: number; delivery_policy: number; delivery_revision: number; presentation_flags: number;
  created_at: Date | string; updated_at: Date | string;
};

const ASSET_COLUMNS = `id, site_id, space_id, folder_id, created_by_user_id, updated_by_user_id,
  owner_user_id, storage_profile_id, storage_key, original_name, content_type, variant_version, bytes, checksum_sha256,
  width, height, blur_data_url, meta, title, alt_text, lifecycle_status, delivery_policy,
  delivery_revision, presentation_flags, created_at, updated_at`;

function mapAsset(row: AssetRow): MediaAssetRecord {
  return {
    id: integer(row.id), siteId: integer(row.site_id), spaceId: integer(row.space_id),
    folderId: row.folder_id == null ? null : integer(row.folder_id),
    createdByUserId: row.created_by_user_id == null ? null : integer(row.created_by_user_id),
    updatedByUserId: row.updated_by_user_id == null ? null : integer(row.updated_by_user_id),
    ownerUserId: row.owner_user_id == null ? null : integer(row.owner_user_id),
    storageProfileId: integer(row.storage_profile_id), storageKey: row.storage_key,
    originalName: row.original_name, contentType: row.content_type,
    variantVersion: row.variant_version == null ? null : integer(row.variant_version),
    bytes: row.bytes == null ? null : integer(row.bytes), checksumSha256: row.checksum_sha256,
    width: row.width == null ? null : integer(row.width), height: row.height == null ? null : integer(row.height),
    blurDataUrl: row.blur_data_url, meta: record(row.meta), title: row.title, altText: row.alt_text,
    lifecycleStatus: integer(row.lifecycle_status), deliveryPolicy: integer(row.delivery_policy),
    deliveryRevision: integer(row.delivery_revision), presentationFlags: integer(row.presentation_flags),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

type VariantRow = {
  asset_id: number; variant_key: number; storage_profile_id: number; storage_key: string;
  content_type: string; bytes: number | string | null; checksum_sha256: string | null;
  width: number; height: number; blur_data_url: string | null; flags: number;
  created_at: Date | string; updated_at: Date | string;
};

const VARIANT_COLUMNS = `asset_id, variant_key, storage_profile_id, storage_key, content_type, bytes,
  checksum_sha256, width, height, blur_data_url, flags, created_at, updated_at`;

function mapVariant(row: VariantRow): ImageAssetVariantRecord {
  return {
    assetId: integer(row.asset_id), variantKey: integer(row.variant_key), storageProfileId: integer(row.storage_profile_id),
    storageKey: row.storage_key, contentType: row.content_type, bytes: row.bytes == null ? null : integer(row.bytes),
    checksumSha256: row.checksum_sha256, width: integer(row.width), height: integer(row.height),
    blurDataUrl: row.blur_data_url, flags: integer(row.flags), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

type UploadRow = {
  token: string; site_id: number; actor_user_id: number; space_id: number; folder_id: number | null;
  storage_profile_id: number; status: number; filename: string; content_type: string; size_bytes: number | string;
  kind: string; upload_plan_kind: number; checksum_sha256: string | null; meta: unknown; presentation_flags: number;
  staging_storage_key: string; final_storage_key: string | null; expires_at: Date | string;
  uploaded_at: Date | string | null; finalized_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
};

const UPLOAD_COLUMNS = `token, site_id, actor_user_id, space_id, folder_id, storage_profile_id, status,
  filename, content_type, size_bytes, kind, upload_plan_kind, checksum_sha256, meta, presentation_flags,
  staging_storage_key, final_storage_key, expires_at, uploaded_at, finalized_at, created_at, updated_at`;

function nullableIso(value: Date | string | null) { return value == null ? null : iso(value); }

function mapUpload(row: UploadRow): MediaUploadSessionRecord {
  return {
    token: row.token, siteId: integer(row.site_id), actorUserId: integer(row.actor_user_id),
    spaceId: integer(row.space_id), folderId: row.folder_id == null ? null : integer(row.folder_id),
    storageProfileId: integer(row.storage_profile_id), status: integer(row.status), filename: row.filename,
    contentType: row.content_type, sizeBytes: integer(row.size_bytes), kind: row.kind,
    uploadPlanKind: integer(row.upload_plan_kind), checksumSha256: row.checksum_sha256, meta: record(row.meta), presentationFlags: integer(row.presentation_flags),
    stagingStorageKey: row.staging_storage_key, finalStorageKey: row.final_storage_key,
    expiresAt: iso(row.expires_at), uploadedAt: nullableIso(row.uploaded_at), finalizedAt: nullableIso(row.finalized_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

async function assertFolderParent(db: DbQueryable, spaceId: number, parentId: number | null) {
  if (parentId == null) return;
  const result = await db.query(`SELECT id FROM phis.media_folders WHERE id = $1 AND space_id = $2`, [parentId, spaceId]);
  if (result.rowCount !== 1) throw new Error("Media Folder parent does not belong to the active Space.");
}

export async function createMediaFolder(input: {
  siteId: number; spaceId: number; parentId?: number | null; name: string; sortOrder?: number; flags?: number;
}) {
  const pool = getPool(); const client = await pool.connect();
  try {
    await client.query("BEGIN"); await assertFolderParent(client, input.spaceId, input.parentId ?? null);
    const { rows } = await client.query<FolderRow>(
      `INSERT INTO phis.media_folders (site_id, space_id, parent_id, name, sort_order, flags)
       SELECT $1, s.id, $3, $4, $5, $6 FROM phis.media_spaces s WHERE s.id = $2 AND s.site_id = $1
       RETURNING id, site_id, space_id, parent_id, name, sort_order, flags, created_at, updated_at`,
      [input.siteId, input.spaceId, input.parentId ?? null, normalizeFolderPathSegment(input.name), input.sortOrder ?? 0, input.flags ?? 0],
    );
    if (!rows[0]) throw new Error("Active Media Space was not found.");
    await client.query("COMMIT"); return mapFolder(rows[0]);
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function updateMediaFolder(input: {
  siteId: number; spaceId: number; folderId: number; parentId?: number | null; name?: string; sortOrder?: number; flags?: number;
}) {
  const pool = getPool(); const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.parentId === input.folderId) throw new Error("Media Folder cannot be its own parent.");
    if (input.parentId !== undefined) await assertFolderParent(client, input.spaceId, input.parentId);
    const sets = ["updated_at = NOW()"];
    const values: Array<number | string | null> = [input.siteId, input.spaceId, input.folderId];
    for (const [column, value] of [["parent_id", input.parentId], ["name", input.name], ["sort_order", input.sortOrder], ["flags", input.flags]] as const) {
      if (value !== undefined) { values.push(column === "name" ? normalizeFolderPathSegment(String(value)) : value); sets.push(`${column} = $${values.length}`); }
    }
    const { rows } = await client.query<FolderRow>(
      `UPDATE phis.media_folders SET ${sets.join(", ")} WHERE site_id = $1 AND space_id = $2 AND id = $3
       RETURNING id, site_id, space_id, parent_id, name, sort_order, flags, created_at, updated_at`, values,
    );
    await client.query("COMMIT"); return rows[0] ? mapFolder(rows[0]) : null;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function resolveOrCreateMediaFolderPath(siteId: number, spaceId: number, folderPath: string[]): Promise<number | null> {
  const path = normalizeMediaFolderPath(folderPath); if (!path) throw new Error("Invalid Media Folder path.");
  const pool = getPool(); const client = await pool.connect(); let parentId: number | null = null;
  try {
    await client.query("BEGIN");
    for (const name of path) {
      const found: { rows: FolderRow[] } = await client.query<FolderRow>(
        `SELECT id, site_id, space_id, parent_id, name, sort_order, flags, created_at, updated_at
         FROM phis.media_folders WHERE site_id = $1 AND space_id = $2
           AND COALESCE(parent_id, 0) = COALESCE($3, 0) AND LOWER(name) = LOWER($4)`,
        [siteId, spaceId, parentId, name],
      );
      const folder: MediaFolderRecord = found.rows[0] ? mapFolder(found.rows[0]) : await createMediaFolderWithDb(client, { siteId, spaceId, parentId, name });
      parentId = folder.id;
    }
    await client.query("COMMIT"); return parentId;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function createMediaFolderWithDb(db: DbQueryable, input: { siteId: number; spaceId: number; parentId: number | null; name: string }) {
  const { rows } = await db.query<FolderRow>(
    `INSERT INTO phis.media_folders (site_id, space_id, parent_id, name)
     VALUES ($1, $2, $3, $4) RETURNING id, site_id, space_id, parent_id, name, sort_order, flags, created_at, updated_at`,
    [input.siteId, input.spaceId, input.parentId, input.name],
  ); return mapFolder(rows[0]!);
}

export async function findMediaFolderPathId(siteId: number, spaceId: number, folderPath: string[] | null | undefined) {
  const path = normalizeMediaFolderPath(folderPath ?? []); if (!path || path.length === 0) return null;
  let parentId: number | null = null;
  for (const name of path) {
    const { rows }: { rows: Array<{ id: number }> } = await getPool().query<{ id: number }>(
      `SELECT id FROM phis.media_folders WHERE site_id = $1 AND space_id = $2
       AND COALESCE(parent_id, 0) = COALESCE($3, 0) AND LOWER(name) = LOWER($4)`,
      [siteId, spaceId, parentId, name],
    ); if (!rows[0]) return null; parentId = rows[0].id;
  } return parentId;
}

export async function listMediaFolders(siteId: number, spaceId: number) {
  const { rows } = await getPool().query<FolderRow>(
    `SELECT id, site_id, space_id, parent_id, name, sort_order, flags, created_at, updated_at
     FROM phis.media_folders WHERE site_id = $1 AND space_id = $2 ORDER BY sort_order, LOWER(name), id`, [siteId, spaceId],
  ); return rows.map(mapFolder);
}

export async function getMediaFolderBySiteAndId(siteId: number, spaceId: number, id: number) {
  const { rows } = await getPool().query<FolderRow>(
    `SELECT id, site_id, space_id, parent_id, name, sort_order, flags, created_at, updated_at
     FROM phis.media_folders WHERE site_id = $1 AND space_id = $2 AND id = $3`, [siteId, spaceId, id],
  ); return rows[0] ? mapFolder(rows[0]) : null;
}

export async function listMediaFolderDescendantIds(siteId: number, spaceId: number, folderId: number) {
  const { rows } = await getPool().query<{ id: number }>(
    `WITH RECURSIVE branch AS (
       SELECT id FROM phis.media_folders WHERE site_id = $1 AND space_id = $2 AND id = $3
       UNION ALL SELECT f.id FROM phis.media_folders f JOIN branch b ON f.parent_id = b.id WHERE f.space_id = $2
     ) SELECT id FROM branch`, [siteId, spaceId, folderId],
  ); return rows.map((row) => integer(row.id));
}

export async function pruneEmptyMediaFolderBranch(siteId: number, spaceId: number, folderId: number) {
  let current: number | null = folderId;
  while (current != null) {
    const { rows }: { rows: Array<{ parent_id: number | null; deleted: boolean }> } = await getPool().query<{ parent_id: number | null; deleted: boolean }>(
      `WITH candidate AS (
         SELECT id, parent_id FROM phis.media_folders WHERE site_id = $1 AND space_id = $2 AND id = $3
       ), removed AS (
         DELETE FROM phis.media_folders f USING candidate c WHERE f.id = c.id
           AND NOT EXISTS (SELECT 1 FROM phis.media_folders child WHERE child.parent_id = f.id)
           AND NOT EXISTS (SELECT 1 FROM phis.media_assets asset WHERE asset.folder_id = f.id)
         RETURNING c.parent_id
       ) SELECT parent_id, TRUE AS deleted FROM removed`, [siteId, spaceId, current],
    ); if (!rows[0]?.deleted) break; current = rows[0].parent_id;
  }
}

export async function deleteMediaFolderBySite(siteId: number, spaceId: number, id: number) {
  const result = await getPool().query(`DELETE FROM phis.media_folders WHERE site_id = $1 AND space_id = $2 AND id = $3`, [siteId, spaceId, id]);
  return (result.rowCount ?? 0) > 0;
}

function appendAssetFilters(parts: string[], values: Array<number | string | number[]>, filters: ListMediaAssetsFilters) {
  values.push(filters.spaceId); parts.push(`AND space_id = $${values.length}`);
  if (filters.id) { values.push(filters.id); parts.push(`AND id = $${values.length}`); }
  if (filters.folderId) { values.push(filters.folderId); parts.push(`AND folder_id = $${values.length}`); }
  if (filters.folderIds?.length) { values.push(filters.folderIds); parts.push(`AND folder_id = ANY($${values.length}::int[])`); }
  if (filters.query?.trim()) { values.push(`%${filters.query.trim().toLowerCase()}%`); parts.push(`AND (LOWER(original_name) LIKE $${values.length} OR LOWER(COALESCE(title, '')) LIKE $${values.length} OR LOWER(COALESCE(alt_text, '')) LIKE $${values.length})`); }
  if (filters.contentType?.trim()) { values.push(filters.contentType.trim()); parts.push(`AND content_type = $${values.length}`); }
  if (filters.presentationFlags) { values.push(filters.presentationFlags); parts.push(`AND (presentation_flags & $${values.length}) <> 0`); }
  if (filters.since) { values.push(filters.since); parts.push(`AND created_at >= $${values.length}::timestamptz`); }
  if (filters.until) { values.push(filters.until); parts.push(`AND created_at <= $${values.length}::timestamptz`); }
  if (filters.kinds?.length) {
    const clauses = filters.kinds.map((kind) => kind === "image" ? "LOWER(content_type) LIKE 'image/%'" : kind === "video" ? "LOWER(content_type) LIKE 'video/%'" : kind === "audio" ? "LOWER(content_type) LIKE 'audio/%'" : kind === "pdf" ? "LOWER(content_type) = 'application/pdf'" : kind === "markdown" ? "LOWER(content_type) = 'text/markdown'" : "FALSE");
    parts.push(`AND (${clauses.join(" OR ")})`);
  }
}

export async function createMediaAsset(input: {
  siteId: number; spaceId: number; spaceKind?: number | null; folderId?: number | null; createdByUserId?: number | null;
  updatedByUserId?: number | null; storageProfileId: number; storageKey: string; originalName: string;
  contentType: string; variantVersion?: number | null; bytes?: number | null; checksumSha256?: string | null;
  width?: number | null; height?: number | null; blurDataUrl?: string | null; meta?: Record<string, unknown> | null;
  title?: string | null; altText?: string | null; lifecycleStatus?: number; deliveryPolicy?: number;
  presentationFlags?: number;
}) {
  // Ownership starts with the creator. It is a separate column because it is free to move afterwards,
  // not because the two ever differ at this point.
  const { rows } = await getPool().query<AssetRow>(
    `INSERT INTO phis.media_assets (site_id, space_id, folder_id, created_by_user_id, updated_by_user_id,
       owner_user_id,
       storage_profile_id, storage_key, original_name, content_type, variant_version, bytes, checksum_sha256,
       width, height, blur_data_url, meta, title, alt_text, lifecycle_status, delivery_policy, presentation_flags)
     VALUES ($1,$2,$3,$4,$5,$4,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21)
     RETURNING ${ASSET_COLUMNS}`,
    [input.siteId,input.spaceId,input.folderId??null,input.createdByUserId??null,input.updatedByUserId??null,
      input.storageProfileId,input.storageKey,input.originalName,input.contentType,input.variantVersion??null,
      input.bytes??null,input.checksumSha256??null,input.width??null,input.height??null,input.blurDataUrl??null,
      JSON.stringify(input.meta??null),input.title??null,input.altText??null,input.lifecycleStatus??PhiMediaLifecycleStatus.Ready,
      input.deliveryPolicy??defaultMediaDeliveryPolicy(input.spaceKind),input.presentationFlags??0],
  ); return rows[0] ? mapAsset(rows[0]) : null;
}

/**
 * What an Asset is visible to before anyone says otherwise.
 *
 * The safe default differs by Space, and defaulting everything to `Public` had it backwards for the
 * two isolated ones: a file uploaded into a User Space is that user's until a Module widens it for a
 * purpose, and a group's file is the group's. The Site Space is Site content and stays public.
 */
export function defaultMediaDeliveryPolicy(spaceKind: number | null | undefined) {
  if (spaceKind === PhiMediaSpaceKind.User) return PhiMediaDeliveryPolicy.User;
  if (spaceKind === PhiMediaSpaceKind.Group) return PhiMediaDeliveryPolicy.Group;
  return PhiMediaDeliveryPolicy.Public;
}

/**
 * Every change rotates `delivery_revision`.
 *
 * The revision is the cache key in every Media URL, and a Public Asset is served `immutable` for a
 * year when the request carries the current one. Anything that leaves the revision standing therefore
 * leaves already-delivered copies valid, which for a narrowed delivery policy means content stays
 * readable to a public that may no longer see it. Rotating on every change rather than on a chosen
 * subset is deliberate: deciding per field which ones are cache-relevant is a judgment that has to be
 * right every time, and the cost of being wrong is asymmetric -- an unnecessary rotation costs one
 * re-download, a missed one serves stale or over-shared bytes until the cache expires on its own.
 *
 * A stale revision in an already-rendered URL still serves; it drops to `must-revalidate` rather than
 * failing, so rotating never breaks a page that was rendered before the change.
 */
export async function updateMediaAsset(input: {
  siteId: number; spaceId: number; assetId: number; updatedByUserId?: number | null; folderId?: number | null;
  variantVersion?: number | null; title?: string | null; altText?: string | null; blurDataUrl?: string | null;
  meta?: Record<string, unknown> | null; lifecycleStatus?: number; deliveryPolicy?: number; presentationFlags?: number;
}) {
  const sets = ["updated_at = NOW()"];
  const values: Array<number | string | null> = [input.siteId, input.spaceId, input.assetId];
  for (const [column, value] of [["updated_by_user_id", input.updatedByUserId], ["folder_id", input.folderId], ["variant_version", input.variantVersion], ["title", input.title], ["alt_text", input.altText], ["blur_data_url", input.blurDataUrl], ["meta", input.meta == null ? input.meta : JSON.stringify(input.meta)], ["lifecycle_status", input.lifecycleStatus], ["delivery_policy", input.deliveryPolicy], ["presentation_flags", input.presentationFlags]] as const) {
    if (value !== undefined) { values.push(value as number | string | null); sets.push(`${column} = $${values.length}${column === "meta" ? "::jsonb" : ""}`); }
  }
  // `updated_at` alone means the caller named no field: a request that changes nothing must not
  // invalidate a cache either.
  if (sets.length > 1) { sets.push("delivery_revision = delivery_revision + 1"); }
  const { rows } = await getPool().query<AssetRow>(
    `UPDATE phis.media_assets SET ${sets.join(", ")} WHERE site_id = $1 AND space_id = $2 AND id = $3 RETURNING ${ASSET_COLUMNS}`, values,
  ); return rows[0] ? mapAsset(rows[0]) : null;
}

export async function getMediaAssetBySiteAndId(siteId: number, id: number, spaceId?: number | null) {
  const values: number[] = [siteId, id]; const scope = spaceId ? ` AND space_id = $3` : ""; if (spaceId) values.push(spaceId);
  const { rows } = await getPool().query<AssetRow>(`SELECT ${ASSET_COLUMNS} FROM phis.media_assets WHERE site_id = $1 AND id = $2${scope}`, values);
  return rows[0] ? mapAsset(rows[0]) : null;
}

/**
 * Resolves `phi:asset/<id>` references for public rendering.
 *
 * The Site Space, Ready lifecycle, and public delivery policy are part of the query rather than a
 * caller-side filter, so an unknown or protected id is simply absent from the result and cannot be
 * distinguished from a deleted one.
 */
export async function listPublicSiteSpaceMediaAssetsByIds(siteId: number, ids: readonly number[]) {
  const uniqueIds = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (uniqueIds.length === 0) return [];
  const { rows } = await getPool().query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM phis.media_assets
     WHERE site_id = $1 AND id = ANY($2::int[])
       AND lifecycle_status = $4 AND delivery_policy = $5
       AND space_id IN (
         SELECT id FROM phis.media_spaces WHERE site_id = $1 AND kind = $3
       )`,
    [
      siteId,
      uniqueIds,
      PhiMediaSpaceKind.Site,
      PhiMediaLifecycleStatus.Ready,
      PhiMediaDeliveryPolicy.Public,
    ],
  );
  return rows.map(mapAsset);
}

export async function getMediaAssetBySiteAndChecksum(siteId: number, spaceId: number, checksumSha256: string) {
  const { rows } = await getPool().query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM phis.media_assets WHERE site_id = $1 AND space_id = $2 AND checksum_sha256 = $3 LIMIT 1`,
    [siteId, spaceId, checksumSha256.trim()],
  ); return rows[0] ? mapAsset(rows[0]) : null;
}

export async function getMediaAssetById(id: number) {
  const { rows } = await getPool().query<AssetRow>(`SELECT ${ASSET_COLUMNS} FROM phis.media_assets WHERE id = $1`, [id]);
  return rows[0] ? mapAsset(rows[0]) : null;
}

export async function listMediaAssetsBySiteWithFilters(siteId: number, filters: ListMediaAssetsFilters) {
  const parts = [`SELECT ${ASSET_COLUMNS} FROM phis.media_assets WHERE site_id = $1`];
  const values: Array<number | string | number[]> = [siteId]; appendAssetFilters(parts, values, filters);
  parts.push("ORDER BY created_at DESC, id DESC");
  if (filters.limit && filters.limit > 0) { values.push(filters.limit); parts.push(`LIMIT $${values.length}`); }
  if (filters.offset != null && filters.offset >= 0) { values.push(filters.offset); parts.push(`OFFSET $${values.length}`); }
  const { rows } = await getPool().query<AssetRow>(parts.join("\n"), values); return rows.map(mapAsset);
}

export async function countMediaAssetsBySiteWithFilters(siteId: number, filters: ListMediaAssetsFilters) {
  const parts = ["SELECT COUNT(*)::text AS total FROM phis.media_assets WHERE site_id = $1"];
  const values: Array<number | string | number[]> = [siteId]; appendAssetFilters(parts, values, filters);
  const { rows } = await getPool().query<{ total: string }>(parts.join("\n"), values); return Number.parseInt(rows[0]?.total ?? "0", 10) || 0;
}

export async function deleteMediaAssetBySite(siteId: number, spaceId: number, id: number) {
  const pool = getPool(); const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deleted = await client.query<{ bytes: number | string | null }>(
      `DELETE FROM phis.media_assets WHERE site_id = $1 AND space_id = $2 AND id = $3 RETURNING bytes`, [siteId, spaceId, id],
    );
    if (deleted.rows[0]) await client.query(`UPDATE phis.media_spaces SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = NOW() WHERE id = $1`, [spaceId, integer(deleted.rows[0].bytes)]);
    await client.query("COMMIT"); return Boolean(deleted.rows[0]);
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

/**
 * Hands an Asset to someone else, or to nobody.
 *
 * Only the owner moves. `created_by_user_id` is history and stays where it is, which is what keeps a
 * handed-over Asset attributable after the person who uploaded it can no longer touch it.
 * `updated_by_user_id` records who performed the handover, because a handover is a change to the row.
 */
export async function setMediaAssetOwner(input: {
  siteId: number;
  assetId: number;
  ownerUserId: number | null;
  actorUserId: number;
}) {
  const { rows } = await getPool().query<AssetRow>(
    `UPDATE phis.media_assets
        SET owner_user_id = $3, updated_by_user_id = $4, updated_at = NOW()
      WHERE site_id = $1 AND id = $2
      RETURNING ${ASSET_COLUMNS}`,
    [input.siteId, input.assetId, input.ownerUserId, input.actorUserId],
  );
  return rows[0] ? mapAsset(rows[0]) : null;
}

export async function getImageAssetVariantByAssetIdAndKey(assetId: number, variantKey: number) {
  const { rows } = await getPool().query<VariantRow>(`SELECT ${VARIANT_COLUMNS} FROM phis.image_asset_variants WHERE asset_id = $1 AND variant_key = $2`, [assetId, variantKey]);
  return rows[0] ? mapVariant(rows[0]) : null;
}
export async function deleteImageAssetVariantsByAssetId(assetId: number) {
  const { rows } = await getPool().query<VariantRow>(`DELETE FROM phis.image_asset_variants WHERE asset_id = $1 RETURNING ${VARIANT_COLUMNS}`, [assetId]); return rows.map(mapVariant);
}
export async function upsertImageAssetVariant(input: {
  assetId: number; variantKey: number; storageProfileId: number; storageKey: string; contentType: string;
  bytes?: number | null; checksumSha256?: string | null; width: number; height: number; blurDataUrl?: string | null; flags?: number;
}) {
  const { rows } = await getPool().query<VariantRow>(
    `INSERT INTO phis.image_asset_variants (asset_id, variant_key, storage_profile_id, storage_key, content_type,
       bytes, checksum_sha256, width, height, blur_data_url, flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (asset_id, variant_key) DO UPDATE SET storage_profile_id=EXCLUDED.storage_profile_id,
       storage_key=EXCLUDED.storage_key, content_type=EXCLUDED.content_type, bytes=EXCLUDED.bytes,
       checksum_sha256=EXCLUDED.checksum_sha256, width=EXCLUDED.width, height=EXCLUDED.height,
       blur_data_url=EXCLUDED.blur_data_url, flags=EXCLUDED.flags, updated_at=NOW()
     RETURNING ${VARIANT_COLUMNS}`,
    [input.assetId,input.variantKey,input.storageProfileId,input.storageKey,input.contentType,input.bytes??null,
      input.checksumSha256??null,input.width,input.height,input.blurDataUrl??null,input.flags??0],
  ); return rows[0] ? mapVariant(rows[0]) : null;
}

export async function createMediaUploadSession(input: {
  token: string; siteId: number; actorUserId: number; spaceId: number; folderId?: number | null;
  storageProfileId: number; status: number; filename: string; contentType: string; sizeBytes: number; kind: string;
  uploadPlanKind: number;
  checksumSha256?: string | null; meta?: Record<string, unknown> | null; presentationFlags?: number;
  stagingStorageKey: string; finalStorageKey?: string | null; expiresAt: string;
  uploadedAt?: string | null; finalizedAt?: string | null;
}) {
  const { rows } = await getPool().query<UploadRow>(
    `INSERT INTO phis.media_upload_sessions (token, site_id, actor_user_id, space_id, folder_id,
       storage_profile_id, status, filename, content_type, size_bytes, kind, upload_plan_kind,
       checksum_sha256, meta, presentation_flags, staging_storage_key, final_storage_key, expires_at,
       uploaded_at, finalized_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20)
     RETURNING ${UPLOAD_COLUMNS}`,
    [input.token,input.siteId,input.actorUserId,input.spaceId,input.folderId??null,input.storageProfileId,input.status,
      input.filename,input.contentType,input.sizeBytes,input.kind,input.uploadPlanKind,input.checksumSha256??null,
      JSON.stringify(input.meta??null),
      input.presentationFlags??0,input.stagingStorageKey,input.finalStorageKey??null,input.expiresAt,input.uploadedAt??null,input.finalizedAt??null],
  ); return rows[0] ? mapUpload(rows[0]) : null;
}

export async function getMediaUploadSessionByToken(token: string) {
  const { rows } = await getPool().query<UploadRow>(`SELECT ${UPLOAD_COLUMNS} FROM phis.media_upload_sessions WHERE token = $1`, [token.trim()]);
  return rows[0] ? mapUpload(rows[0]) : null;
}

export async function updateMediaUploadSessionByToken(token: string, input: {
  status?: number; checksumSha256?: string | null; folderId?: number | null; meta?: Record<string, unknown> | null;
  presentationFlags?: number; finalStorageKey?: string | null; expiresAt?: string; uploadedAt?: string | null; finalizedAt?: string | null;
}) {
  const sets = ["updated_at = NOW()"];
  const values: Array<number | string | null> = [token.trim()];
  for (const [column, value] of [["status",input.status],["checksum_sha256",input.checksumSha256],["folder_id",input.folderId],
    ["meta",input.meta == null ? input.meta : JSON.stringify(input.meta)],["presentation_flags",input.presentationFlags],
    ["final_storage_key",input.finalStorageKey],["expires_at",input.expiresAt],["uploaded_at",input.uploadedAt],["finalized_at",input.finalizedAt]] as const) {
    if (value !== undefined) { values.push(value as number|string|null); sets.push(`${column} = $${values.length}${column === "meta" ? "::jsonb" : ""}`); }
  }
  const { rows } = await getPool().query<UploadRow>(`UPDATE phis.media_upload_sessions SET ${sets.join(", ")} WHERE token = $1 RETURNING ${UPLOAD_COLUMNS}`, values);
  return rows[0] ? mapUpload(rows[0]) : null;
}

export async function deleteMediaUploadSessionByToken(token: string) {
  const result = await getPool().query(`DELETE FROM phis.media_upload_sessions WHERE token = $1`, [token.trim()]); return (result.rowCount ?? 0) > 0;
}

/**
 * Aborts an upload session: removes the row and releases its quota reservation in one statement.
 *
 * This is the required teardown for every non-success path — expiry, validation failure, duplicate,
 * and transport errors (`GROUPS_AND_STORAGE.md` section 7 step 6). The single statement makes the
 * release idempotent: a second call finds no row and therefore releases nothing, so a retry can never
 * free bytes that belong to another session's reservation. The plain delete remains for the success
 * path, where the reservation has already been committed to `used_bytes`.
 */
export async function abortMediaUploadSessionByToken(token: string) {
  const result = await getPool().query(
    `WITH removed AS (
       DELETE FROM phis.media_upload_sessions WHERE token = $1
       RETURNING space_id, size_bytes
     )
     UPDATE phis.media_spaces s
     SET reserved_bytes = GREATEST(0, s.reserved_bytes - r.size_bytes), updated_at = NOW()
     FROM removed r
     WHERE s.id = r.space_id`,
    [token.trim()],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Releases the reservations of one Media Space's expired upload sessions.
 *
 * Runs on the request that needs the capacity rather than on a timer, to the maintenance contract in
 * `AGENTS.md`: a reservation only ever reduces its own Space's headroom, so nobody but the next
 * uploader into that Space is waiting for it, and a Space nobody uploads into needs no sweep. One
 * statement, like the abort it mirrors, so a concurrent init can never observe the rows gone and their
 * bytes still counted.
 *
 * The staging object each session left in storage is not chased here. That is what no request can
 * reach: for S3 it belongs to a bucket lifecycle rule, for Local to a deliberate operator command.
 */
export async function releaseExpiredMediaUploadSessions(spaceId: number) {
  if (!Number.isInteger(spaceId) || spaceId <= 0) return 0;
  const { rows } = await getPool().query<{ released: number }>(
    `WITH expired AS (
       DELETE FROM phis.media_upload_sessions
       WHERE space_id = $1 AND expires_at < NOW()
       RETURNING size_bytes
     ), freed AS (
       SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes, COUNT(*)::int AS sessions FROM expired
     )
     UPDATE phis.media_spaces s
     SET reserved_bytes = GREATEST(0, s.reserved_bytes - f.bytes), updated_at = NOW()
     FROM freed f
     WHERE s.id = $1 AND f.sessions > 0
     RETURNING f.sessions AS released`,
    [spaceId],
  );
  return rows[0]?.released ?? 0;
}

/**
 * Commits an upload session: moves its reserved bytes to used and removes the row, in one transaction.
 *
 * The two halves have to be inseparable. While the row exists its bytes are reserved, and while it is
 * gone they are used -- never both and never neither. A window between them is what would let the
 * expiry release above subtract the same bytes a second time, and the bytes it would take belong to
 * whichever session reserved next.
 */
export async function commitMediaUploadSessionByToken(token: string) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: number }>(
      `UPDATE phis.media_spaces s
       SET reserved_bytes = GREATEST(0, s.reserved_bytes - u.size_bytes),
           used_bytes = s.used_bytes + u.size_bytes,
           updated_at = NOW()
       FROM phis.media_upload_sessions u
       WHERE u.token = $1 AND s.id = u.space_id AND s.reserved_bytes >= u.size_bytes
       RETURNING s.id`,
      [token.trim()],
    );
    if (!rows[0]) throw new Error("Media Space quota reservation is no longer available.");
    await client.query(`DELETE FROM phis.media_upload_sessions WHERE token = $1`, [token.trim()]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type MediaProviderContext = { space: MediaSpaceRecord; storageProfile: MediaStorageProfileRecord };
