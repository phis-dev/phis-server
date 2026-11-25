import type { Pool, PoolClient } from "pg";

import { PhisMediaSpaceKind } from "../lib/constants/media-space-kinds.ts";

/*
 * A Media Space's two counters, `reserved_bytes` and `used_bytes`, in SQL the CLI can load as well as
 * the Server: `src/db/media-spaces.ts` is `server-only`, and the CDN pipeline (`src/lib/cdn-publish.mts`)
 * books what it copies into the Site Space from `phis cdn publish` as much as from a request.
 *
 * `media-spaces.ts` keeps its readers and calls these for the statements both sides need, so there is
 * one predicate for what a reservation is measured against.
 */

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Reserved bytes as a reader must understand them.
 *
 * `media_spaces.reserved_bytes` is a counter, and an upload session that expired without anyone
 * touching it again leaves its share standing in that counter until the next reservation against the
 * same Space releases it. A read therefore discounts what is already dead instead of repairing it --
 * the maintenance contract in `AGENTS.md` gives the repair to the writer and the truth to the reader,
 * over the same predicate, so what is reported free is what the next request will actually grant.
 */
export function liveMediaSpaceReservedBytesSql(alias: string) {
  const space = alias ? `${alias}.` : "";
  return `GREATEST(0, ${space}reserved_bytes - COALESCE((
              SELECT SUM(u.size_bytes)
              FROM phis.media_upload_sessions u
              WHERE u.space_id = ${space}id AND u.expires_at < NOW()
            ), 0))`;
}

/**
 * Reserves `bytes` in one Space against its effective quota; false where they do not fit.
 *
 * The comparison discounts dead reservations exactly as a reader does, so the capacity a Client was
 * shown is the capacity it gets. The counter itself is still raised by the raw amount: releasing those
 * bytes is the business of the statement that also removes their rows, and doing it here would free
 * them twice. An expired session cannot finalize, so nothing discounted here can ever be committed.
 */
export async function reserveMediaSpaceQuotaWithDb(db: Queryable, input: { spaceId: number; bytes: number }) {
  const { rows } = await db.query<{ id: number }>(
    `WITH effective AS (
       SELECT s.id,
              COALESCE(
                s.quota_bytes,
                CASE s.kind
                  WHEN ${PhisMediaSpaceKind.User} THEN c.default_user_quota_bytes
                  WHEN ${PhisMediaSpaceKind.Group} THEN c.default_group_quota_bytes
                  WHEN ${PhisMediaSpaceKind.Addon} THEN c.default_addon_quota_bytes
                END
              ) AS quota
       FROM phis.media_spaces s
       LEFT JOIN phis.site_media_config c ON c.site_id = s.site_id
       WHERE s.id = $1
     )
     UPDATE phis.media_spaces s
     SET reserved_bytes = s.reserved_bytes + $2, updated_at = NOW()
     FROM effective e
     WHERE s.id = e.id AND $2 > 0
       AND (e.quota IS NULL OR s.used_bytes + ${liveMediaSpaceReservedBytesSql("s")} + $2 <= e.quota)
     RETURNING s.id`,
    [input.spaceId, input.bytes],
  );
  return Boolean(rows[0]);
}

/** Gives a reservation back that will not be committed. */
export async function releaseMediaSpaceReservationWithDb(db: Queryable, input: { spaceId: number; bytes: number }) {
  await db.query(
    `UPDATE phis.media_spaces SET reserved_bytes = GREATEST(0, reserved_bytes - $2), updated_at = NOW()
     WHERE id = $1`,
    [input.spaceId, input.bytes],
  );
}

/**
 * Moves reserved bytes to used, for a write that reserved them earlier. Throws where the reservation is
 * not there to move, so the caller's transaction does not record bytes nobody booked.
 */
export async function commitMediaSpaceReservationWithDb(db: Queryable, input: { spaceId: number; bytes: number }) {
  const { rowCount } = await db.query(
    `UPDATE phis.media_spaces
        SET reserved_bytes = GREATEST(0, reserved_bytes - $2), used_bytes = used_bytes + $2, updated_at = NOW()
      WHERE id = $1 AND reserved_bytes >= $2`,
    [input.spaceId, input.bytes],
  );
  if ((rowCount ?? 0) === 0) throw new Error("Media Space quota reservation is no longer available.");
}

/**
 * Changes `used_bytes` by `delta`, without a quota check and never below zero: bytes that are stored
 * whether or not they fit (what the operator publishes, what a bucket check adopts) and bytes that are
 * gone (a CDN file deleted).
 */
export async function changeMediaSpaceUsedBytesWithDb(db: Queryable, input: { spaceId: number; delta: number }) {
  if (input.delta === 0) return;
  await db.query(
    `UPDATE phis.media_spaces SET used_bytes = GREATEST(0, used_bytes + $2), updated_at = NOW() WHERE id = $1`,
    [input.spaceId, input.delta],
  );
}

/**
 * The Site Space's id, or null where the Site has none yet: the Server makes it on the first Media read
 * (`ensureSiteMediaSpace`), which a Site that serves anything has had long before it has a CDN.
 */
export async function readSiteMediaSpaceIdWithDb(db: Queryable, siteId: number): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM phis.media_spaces WHERE site_id = $1 AND kind = ${PhisMediaSpaceKind.Site}`,
    [siteId],
  );
  return rows[0]?.id ?? null;
}

/**
 * The largest object the Site's Media settings allow (`site_media_config.max_object_bytes`), or null
 * where the row was never materialized: the Server writes it on the first Media request, and a reader
 * here does not invent the column's default.
 */
export async function readSiteMaxObjectBytesWithDb(db: Queryable, siteId: number): Promise<number | null> {
  const { rows } = await db.query<{ max_object_bytes: string }>(
    `SELECT max_object_bytes::text FROM phis.site_media_config WHERE site_id = $1`,
    [siteId],
  );
  return rows[0] ? Number(rows[0].max_object_bytes) : null;
}
