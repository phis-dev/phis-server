import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { PHI_SERVER_ADDON_ASSET_STATUS } from "@/lib/addons/schema-ddl";
import { quotePhiIdentifier } from "@/lib/addons/schema-ddl";
import {
  PHI_SERVER_ADDON_ASSET_PREFIX,
  composePhiServerAddonAssetTableName,
  phiServerAddonStoragePrefix,
} from "@/lib/addons/schema-name";

/**
 * The two halves of putting a file on a row: reserving a place for it, and settling it once it landed.
 *
 * The order is what makes the table trustworthy. A row is written **before** the transfer starts, as
 * `pending` with an expiry, and becomes `ready` only once the bytes are complete and measured. The
 * alternative -- write the row after -- leaves an object nobody knows about for the length of every
 * transfer, and leaves nothing at all behind when the transfer is abandoned halfway.
 *
 * So the failure that would otherwise be undetectable, a row naming an object that is not there, cannot
 * occur: while the object is incomplete the row says so, and every query an Add-on has reads finished
 * rows only. What an abandoned upload leaves is a pending row past its expiry, which is a `WHERE` rather
 * than a listing of a bucket.
 *
 * The object key is Core's. It is derived from a random component rather than from the row, so replacing
 * a file writes a new object instead of overwriting the current one -- overwriting destroys the file
 * that is still in use before the row that replaces it exists, and a transfer that then fails has
 * destroyed something it never managed to replace.
 */

export type PhiServerAddonAssetRow = {
  id: string;
  slot: string;
  ownerId: string;
  status: number;
  storageKey: string;
  byteSize: number;
  contentType: string;
  checksumSha256: string | null;
  createdAt: string;
};

type AssetLocation = { schemaName: string; table: string };

function qualifyAssets(location: AssetLocation) {
  return `${quotePhiIdentifier(location.schemaName)}.${
    quotePhiIdentifier(composePhiServerAddonAssetTableName(location.table))
  }`;
}

const SELECTED = `id, slot, owner_id, status, storage_key, byte_size, content_type,
  checksum_sha256, created_at`;

type RawRow = {
  id: string; slot: string; owner_id: string; status: number; storage_key: string;
  byte_size: string; content_type: string; checksum_sha256: string | null; created_at: Date;
};

function toRow(row: RawRow): PhiServerAddonAssetRow {
  return {
    id: String(row.id),
    slot: row.slot,
    ownerId: String(row.owner_id),
    status: row.status,
    storageKey: row.storage_key,
    // `bigint` arrives as a string from `pg`, and a byte count is exactly the column that outgrows one.
    byteSize: Number(row.byte_size),
    contentType: row.content_type,
    checksumSha256: row.checksum_sha256,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The key an object gets, which the Add-on never chooses.
 *
 * Inside the Add-on's own prefix, and under `assets/` within it. The first half is what a purge empties
 * and what keeps two Add-ons on one Site apart; the second is the only place the sweep is allowed to
 * look. An Add-on writing its own keys through `storage:v1` writes beside `assets/` and never into it,
 * so a sweep comparing that sub-prefix against the rows can never mistake one of those for an orphan.
 *
 * The random component is what makes replacing safe: a new file is a new object, so the one still in
 * use is not destroyed before the row that replaces it exists.
 */
export function phiServerAddonAssetKey(input: {
  addonId: string;
  siteKey: string;
  table: string;
  slot: string;
}) {
  return `${phiServerAddonStoragePrefix(input.addonId, input.siteKey)}/` +
    `${PHI_SERVER_ADDON_ASSET_PREFIX}/${input.table}/${input.slot}/${randomUUID()}`;
}

export type PhiServerAddonAssetReservation = {
  id: string;
  token: string;
  storageKey: string;
  expiresAt: string;
};

/**
 * Writes the pending row and hands back what redeems it.
 *
 * The size is stated here rather than discovered later. `finalize` holds the object to it, so a client
 * that reserved a kilobyte and delivered a gigabyte is refused by comparison rather than by trust -- and
 * the quota is booked against a number that was agreed before any bytes moved.
 */
export async function beginPhiServerAddonAsset(
  db: Pool | PoolClient,
  input: {
    location: AssetLocation;
    siteId: number;
    ownerId: string | number;
    slot: string;
    contentType: string;
    sizeBytes: number;
    storageKey: string;
    expiresAt: Date;
  },
): Promise<PhiServerAddonAssetReservation> {
  const token = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ${qualifyAssets(input.location)}
       (site_id, owner_id, slot, status, storage_key, byte_size, content_type, upload_token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.siteId,
      String(input.ownerId),
      input.slot,
      PHI_SERVER_ADDON_ASSET_STATUS.pending,
      input.storageKey,
      input.sizeBytes,
      input.contentType,
      token,
      input.expiresAt,
    ],
  );
  return {
    id: String(rows[0]!.id),
    token,
    storageKey: input.storageKey,
    expiresAt: input.expiresAt.toISOString(),
  };
}

export type PhiServerAddonAssetReservationRow = PhiServerAddonAssetRow & {
  siteId: number;
  expiresAt: string | null;
};

/**
 * Finds a live reservation, which is the only thing a transfer may be carried out against.
 *
 * Expiry is part of the lookup and not a check afterwards. A reservation that has run out is not a
 * reservation an extra branch happens to reject: it is simply not found, the same as one that was never
 * issued, and there is then no path on which a stale token writes anything.
 */
export async function readPhiServerAddonAssetReservation(
  db: Pool | PoolClient,
  location: AssetLocation,
  token: string,
): Promise<PhiServerAddonAssetReservationRow | null> {
  const { rows } = await db.query<RawRow & { site_id: number; expires_at: Date | null }>(
    `SELECT ${SELECTED}, site_id, expires_at
       FROM ${qualifyAssets(location)}
      WHERE upload_token = $1 AND status = $2 AND expires_at > NOW()`,
    [token, PHI_SERVER_ADDON_ASSET_STATUS.pending],
  );
  const row = rows[0];
  return row
    ? {
        ...toRow(row),
        siteId: row.site_id,
        expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      }
    : null;
}

/**
 * Marks a reservation finished, and reports what the previous file was.
 *
 * A single-valued slot holds one finished row, so the one being replaced has to go in the same statement
 * that promotes its replacement -- otherwise the partial unique index refuses the promotion and the new
 * file is stranded, complete and unreachable. The old row is returned rather than deleted quietly,
 * because its object is now unreferenced and something has to be told so.
 *
 * `byteSize` is what actually landed, not what was reserved. They agree wherever the transfer went as
 * agreed; where they do not, this is the figure the quota is corrected against.
 */
export async function finalizePhiServerAddonAsset(
  db: PoolClient,
  input: {
    location: AssetLocation;
    id: string;
    byteSize: number;
    checksumSha256: string | null;
    /** True for a slot declared `one`: the finished row it replaces has to be removed here. */
    single: boolean;
  },
): Promise<{ asset: PhiServerAddonAssetRow; superseded: PhiServerAddonAssetRow | null } | null> {
  const table = qualifyAssets(input.location);
  const { rows: pending } = await db.query<RawRow & { site_id: number }>(
    `SELECT ${SELECTED}, site_id FROM ${table} WHERE id = $1 AND status = $2 FOR UPDATE`,
    [input.id, PHI_SERVER_ADDON_ASSET_STATUS.pending],
  );
  const reservation = pending[0];
  if (!reservation) {
    return null;
  }

  let superseded: PhiServerAddonAssetRow | null = null;
  if (input.single) {
    const { rows } = await db.query<RawRow>(
      `DELETE FROM ${table}
        WHERE site_id = $1 AND owner_id = $2 AND slot = $3 AND status = $4 AND id <> $5
        RETURNING ${SELECTED}`,
      [
        reservation.site_id,
        reservation.owner_id,
        reservation.slot,
        PHI_SERVER_ADDON_ASSET_STATUS.ready,
        input.id,
      ],
    );
    superseded = rows[0] ? toRow(rows[0]) : null;
  }

  const { rows } = await db.query<RawRow>(
    `UPDATE ${table}
        SET status = $2, byte_size = $3, checksum_sha256 = $4,
            upload_token = NULL, expires_at = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING ${SELECTED}`,
    [input.id, PHI_SERVER_ADDON_ASSET_STATUS.ready, input.byteSize, input.checksumSha256],
  );
  return { asset: toRow(rows[0]!), superseded };
}

/** Gives a reservation up. Returns the row so its object can be removed; the bytes are not this file's. */
export async function abandonPhiServerAddonAsset(
  db: Pool | PoolClient,
  location: AssetLocation,
  input: { id: string; siteId: number },
): Promise<PhiServerAddonAssetRow | null> {
  const { rows } = await db.query<RawRow>(
    `DELETE FROM ${qualifyAssets(location)}
      WHERE id = $1 AND site_id = $2 AND status = $3
      RETURNING ${SELECTED}`,
    [input.id, input.siteId, PHI_SERVER_ADDON_ASSET_STATUS.pending],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** The finished files of a row. Pending ones are absent, because they are not files yet. */
export async function readPhiServerAddonAssets(
  db: Pool | PoolClient,
  location: AssetLocation,
  input: { siteId: number; ownerId: string | number; slot?: string },
): Promise<PhiServerAddonAssetRow[]> {
  const { rows } = await db.query<RawRow>(
    `SELECT ${SELECTED} FROM ${qualifyAssets(location)}
      WHERE site_id = $1 AND owner_id = $2 AND status = $3
        AND ($4::text IS NULL OR slot = $4)
      ORDER BY slot, created_at, id`,
    [
      input.siteId,
      String(input.ownerId),
      PHI_SERVER_ADDON_ASSET_STATUS.ready,
      input.slot ?? null,
    ],
  );
  return rows.map(toRow);
}

/** Removes one finished file, and reports the object that is now unreferenced. */
export async function removePhiServerAddonAsset(
  db: Pool | PoolClient,
  location: AssetLocation,
  input: { id: string; siteId: number },
): Promise<PhiServerAddonAssetRow | null> {
  const { rows } = await db.query<RawRow>(
    `DELETE FROM ${qualifyAssets(location)}
      WHERE id = $1 AND site_id = $2 AND status = $3
      RETURNING ${SELECTED}`,
    [input.id, input.siteId, PHI_SERVER_ADDON_ASSET_STATUS.ready],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Reservations that were never redeemed and have run out of time.
 *
 * Reported rather than acted on: their objects live in a store this module has no handle to, and the
 * order that does not lose data is rows last. The caller removes the bytes, then removes these.
 */
export async function readExpiredPhiServerAddonAssets(
  db: Pool | PoolClient,
  location: AssetLocation,
  limit = 500,
): Promise<PhiServerAddonAssetRow[]> {
  const { rows } = await db.query<RawRow>(
    `SELECT ${SELECTED} FROM ${qualifyAssets(location)}
      WHERE status = $1 AND expires_at <= NOW()
      ORDER BY expires_at
      LIMIT $2`,
    [PHI_SERVER_ADDON_ASSET_STATUS.pending, limit],
  );
  return rows.map(toRow);
}

export async function dropPhiServerAddonAssetRows(
  db: Pool | PoolClient,
  location: AssetLocation,
  ids: string[],
) {
  if (ids.length === 0) {
    return 0;
  }
  const { rowCount } = await db.query(
    `DELETE FROM ${qualifyAssets(location)} WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  return rowCount ?? 0;
}
