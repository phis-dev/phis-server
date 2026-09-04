import type { Pool, PoolClient } from "pg";

import { quotePhiIdentifier } from "@/lib/addons/schema-ddl";
import { composePhisAddonAssetTableName } from "@/lib/addons/schema-name";

/**
 * The rows that say which of an Add-on's files sits in which slot on which row.
 *
 * They hold a link and nothing else. Where the object is, how big it turned out, what type it is and
 * which digest it carries live once, in `media_assets`, for every upload Core has ever handled -- so
 * there is no second copy here to fall out of step, and no object key an Add-on could be handed.
 *
 * Nothing in this file is provisional. A row exists only because an upload finished, which is what lets
 * the single-valued rule be a plain unique index instead of a partial one: while the reservation lived
 * in this table, counting it would have refused the very transfer meant to replace the current file.
 * The reservation is Core's upload session now, and this table holds facts.
 */

export type PhisAddonAssetRow = {
  id: string;
  slot: string;
  ownerId: string;
  mediaAssetId: number;
  byteSize: number;
  contentType: string;
  checksumAlgorithm: string | null;
  checksumValue: string | null;
  originalName: string;
  /** The cache revision the delivery URL carries. Rotates whenever the file's delivery changes. */
  deliveryRevision: number;
  createdAt: string;
};

export type PhisAddonAssetLocation = { schemaName: string; table: string };

function qualifyAssets(location: PhisAddonAssetLocation) {
  return `${quotePhiIdentifier(location.schemaName)}.${
    quotePhiIdentifier(composePhisAddonAssetTableName(location.table))
  }`;
}

/** The link's own columns plus the facts, read from where they actually live. */
const SELECTED = `l.id, l.slot, l.owner_id, l.media_asset_id, l.created_at,
  a.bytes, a.content_type, a.checksum_algorithm, a.checksum_value, a.original_name,
  a.delivery_revision`;

type RawRow = {
  id: string; slot: string; owner_id: string; media_asset_id: number; created_at: Date;
  bytes: string | null; content_type: string;
  checksum_algorithm: string | null; checksum_value: string | null; original_name: string;
  delivery_revision: number;
};

function toRow(row: RawRow): PhisAddonAssetRow {
  return {
    id: String(row.id),
    slot: row.slot,
    ownerId: String(row.owner_id),
    mediaAssetId: row.media_asset_id,
    // `bigint` arrives as a string from `pg`, and a byte count is exactly the column that outgrows one.
    byteSize: Number(row.bytes ?? 0),
    contentType: row.content_type,
    checksumAlgorithm: row.checksum_algorithm,
    checksumValue: row.checksum_value,
    originalName: row.original_name,
    deliveryRevision: Number(row.delivery_revision),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Puts a finished file into a slot, and reports the file it displaced.
 *
 * A single-valued slot holds one file, so the one being replaced has to go in the same statement that
 * puts its replacement there -- otherwise the unique index refuses the insert and the new file is
 * stranded, complete and unreachable. The displaced row is returned rather than dropped quietly,
 * because its Media Asset is now unreferenced and something has to be told so.
 */
export async function linkPhisAddonAsset(
  client: PoolClient,
  input: {
    location: PhisAddonAssetLocation;
    siteId: number;
    ownerId: string | number;
    slot: string;
    mediaAssetId: number;
    /** True for a slot declared `one`: whatever is in it has to make way. */
    single: boolean;
  },
): Promise<{ id: string; supersededMediaAssetId: number | null }> {
  const table = qualifyAssets(input.location);
  let superseded: number | null = null;
  if (input.single) {
    const { rows } = await client.query<{ media_asset_id: number }>(
      `DELETE FROM ${table}
        WHERE site_id = $1 AND owner_id = $2 AND slot = $3
        RETURNING media_asset_id`,
      [input.siteId, String(input.ownerId), input.slot],
    );
    superseded = rows[0]?.media_asset_id ?? null;
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ${table} (site_id, owner_id, slot, media_asset_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.siteId, String(input.ownerId), input.slot, input.mediaAssetId],
  );
  return { id: String(rows[0]!.id), supersededMediaAssetId: superseded };
}

/** The files of a row. There is no unfinished state to filter out. */
export async function readPhisAddonAssets(
  db: Pool | PoolClient,
  location: PhisAddonAssetLocation,
  input: { siteId: number; ownerId: string | number; slot?: string },
): Promise<PhisAddonAssetRow[]> {
  const { rows } = await db.query<RawRow>(
    `SELECT ${SELECTED}
       FROM ${qualifyAssets(location)} l
       JOIN phis.media_assets a ON a.id = l.media_asset_id AND a.site_id = l.site_id
      WHERE l.site_id = $1 AND l.owner_id = $2 AND ($3::text IS NULL OR l.slot = $3)
      ORDER BY l.slot, l.created_at, l.id`,
    [input.siteId, String(input.ownerId), input.slot ?? null],
  );
  return rows.map(toRow);
}

export async function readPhisAddonAsset(
  db: Pool | PoolClient,
  location: PhisAddonAssetLocation,
  input: { siteId: number; id: string },
): Promise<PhisAddonAssetRow | null> {
  const { rows } = await db.query<RawRow>(
    `SELECT ${SELECTED}
       FROM ${qualifyAssets(location)} l
       JOIN phis.media_assets a ON a.id = l.media_asset_id AND a.site_id = l.site_id
      WHERE l.site_id = $1 AND l.id = $2`,
    [input.siteId, input.id],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Takes a file out of its slot, and reports the Media Asset that is now unreferenced.
 *
 * Only the link goes here. Removing the Asset itself is Media's business and runs afterwards, because
 * it is the step that touches the store and the Space's figures -- and doing it in this order means a
 * failure there leaves a file nobody points at rather than a row pointing at nothing.
 */
export async function unlinkPhisAddonAsset(
  db: Pool | PoolClient,
  location: PhisAddonAssetLocation,
  input: { siteId: number; id: string },
): Promise<number | null> {
  const { rows } = await db.query<{ media_asset_id: number }>(
    `DELETE FROM ${qualifyAssets(location)}
      WHERE site_id = $1 AND id = $2
      RETURNING media_asset_id`,
    [input.siteId, input.id],
  );
  return rows[0]?.media_asset_id ?? null;
}
