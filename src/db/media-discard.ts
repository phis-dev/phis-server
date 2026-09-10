import "server-only";

import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";

/**
 * Taking Media Assets out of the database and writing down the objects they stood for.
 *
 * The store cannot take part in a transaction. Whatever order rows are removed in, the object is the
 * last step and the first that can fail on its own -- and the moment the Asset row is gone, the storage
 * key is gone with it, so nothing can name the object again. What is left is a file no query can find,
 * counted against nothing and indistinguishable from one still in use.
 *
 * So the key is written down in the same transaction that removes the row, and the removal that follows
 * clears the note. A note that survives is a retry, and the list of them is short enough to read
 * directly -- which is the difference that matters: the alternative is asking a Space which of its
 * files nothing points at, and that question costs the whole Space every time it is asked.
 */

export type PhiDiscardedMediaObject = {
  id: string;
  storageProfileId: number;
  storageKey: string;
};

export type PhiMediaDiscardResult = {
  /** The Assets that were still there, and are now gone. */
  assetIds: number[];
  /** What those Assets and their variants stood for in the store, each already written down. */
  objects: PhiDiscardedMediaObject[];
};

/**
 * Removes Assets, gives their bytes back to the Spaces that carried them, and records their objects.
 *
 * Runs on the caller's client rather than on a pool, because the whole point is to sit in the same
 * transaction as whatever removed the last reference. A note written afterwards is a note a crash can
 * skip, and the crash is the case it exists for.
 *
 * The variants go first. They cascade when the Asset goes, so reading them afterwards would find
 * nothing and their objects would be the ones left behind.
 */
export async function discardPhiMediaAssets(
  client: PoolClient,
  input: { siteId: number; assetIds: readonly number[] },
): Promise<PhiMediaDiscardResult> {
  const assetIds = [...new Set(input.assetIds)];
  if (assetIds.length === 0) {
    return { assetIds: [], objects: [] };
  }

  const { rows: variants } = await client.query<{ storage_profile_id: number; storage_key: string }>(
    `DELETE FROM phis.image_asset_variants
      WHERE asset_id = ANY($1::int[])
     RETURNING storage_profile_id, storage_key`,
    [assetIds],
  );

  const { rows: assets } = await client.query<{
    id: number; space_id: number; bytes: string | number | null;
    storage_profile_id: number; storage_key: string;
  }>(
    `DELETE FROM phis.media_assets
      WHERE site_id = $1 AND id = ANY($2::int[])
     RETURNING id, space_id, bytes, storage_profile_id, storage_key`,
    [input.siteId, assetIds],
  );
  if (assets.length === 0) {
    return { assetIds: [], objects: [] };
  }

  const freed = new Map<number, number>();
  for (const asset of assets) {
    freed.set(asset.space_id, (freed.get(asset.space_id) ?? 0) + Number(asset.bytes ?? 0));
  }
  for (const [spaceId, bytes] of freed) {
    await client.query(
      `UPDATE phis.media_spaces
          SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = NOW()
        WHERE id = $1`,
      [spaceId, bytes],
    );
  }

  const objects = [...assets, ...variants];
  /*
   * `DO UPDATE` rather than `DO NOTHING`, so a key that is already on the list comes back as a row.
   *
   * The conflict is the retry: an earlier removal wrote the key down and could not carry it out. Saying
   * nothing there would drop it from this caller's answer and leave it to whoever reads the list next,
   * which is a longer wait for no reason.
   */
  const { rows: recorded } = await client.query<{
    id: string; storage_profile_id: number; storage_key: string;
  }>(
    `INSERT INTO phis.media_discarded_objects (site_id, storage_profile_id, storage_key)
     SELECT $1, profile, key FROM UNNEST($2::int[], $3::text[]) AS t(profile, key)
     ON CONFLICT (storage_profile_id, storage_key) DO UPDATE SET discarded_at = NOW()
     RETURNING id, storage_profile_id, storage_key`,
    [
      input.siteId,
      objects.map((object) => object.storage_profile_id),
      objects.map((object) => object.storage_key),
    ],
  );

  return {
    assetIds: assets.map((asset) => asset.id),
    objects: recorded.map((row) => ({
      id: String(row.id),
      storageProfileId: row.storage_profile_id,
      storageKey: row.storage_key,
    })),
  };
}

/**
 * The same discard, in a transaction of its own, for a caller that has no client to lend it.
 *
 * A single-Asset deletion has nothing else to sit inside, and the transaction is still what makes the
 * note and the removed row one fact. It belongs here rather than at the caller because that is where
 * `BEGIN` is allowed to be written: the boundary in AGENTS.md puts database execution under `src/db/`,
 * and a transaction is execution.
 */
export async function discardPhiMediaAssetsInTransaction(
  input: { siteId: number; assetIds: readonly number[] },
): Promise<PhiMediaDiscardResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const discarded = await discardPhiMediaAssets(client, input);
    await client.query("COMMIT");
    return discarded;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The oldest notes still standing, for a caller about to talk to the store anyway.
 *
 * Bounded and ordered, because this is meant to be paid for by an ordinary request: an indexed read of
 * a handful of rows costs what it costs whether the list is empty or long, and the debt drains at the
 * rate things are deleted rather than waiting for somebody to run a command.
 */
export async function readPhiDiscardedMediaObjects(
  siteId: number,
  limit: number,
): Promise<PhiDiscardedMediaObject[]> {
  const { rows } = await getPool().query<{
    id: string; storage_profile_id: number; storage_key: string;
  }>(
    `SELECT id, storage_profile_id, storage_key
       FROM phis.media_discarded_objects
      WHERE site_id = $1
      ORDER BY discarded_at, id
      LIMIT $2`,
    [siteId, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    storageProfileId: row.storage_profile_id,
    storageKey: row.storage_key,
  }));
}

/** Clears the notes for objects the store no longer has. */
export async function forgetPhiDiscardedMediaObjects(ids: readonly string[]) {
  if (ids.length === 0) {
    return 0;
  }
  const { rowCount } = await getPool().query(
    `DELETE FROM phis.media_discarded_objects WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  return rowCount ?? 0;
}
