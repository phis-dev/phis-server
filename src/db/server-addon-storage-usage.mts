import type { Pool } from "pg";

/**
 * What an Add-on's object store holds on one Site, and whether it may hold more.
 *
 * The ceiling is Core's. A package that could check its own limit could equally not check it, so the
 * number that decides sits where the Add-on cannot reach it, and `put` consults it whether or not the
 * Add-on ever asked.
 *
 * Booking is one conditional statement rather than a read followed by a write. Two uploads arriving
 * together would both read the same total, both find room, and both proceed -- and the store would end
 * up over its ceiling with nothing in the log to say when. An `UPDATE` that matches no row *is* the
 * refusal, and the database decides it, once, per attempt. It is the same shape `reserveMediaSpaceBytes`
 * uses for the Site's own quota, for the same reason.
 */

export type PhiServerAddonStorageUsage = {
  bytes: number;
  objects: number;
  quotaBytes: number | null;
  quotaObjects: number | null;
};

/** `bigint` arrives as a string from `pg`, and a byte total is exactly the column that outgrows a number. */
function asNumber(value: number | string | null): number {
  return value == null ? 0 : Number(value);
}

function asNullableNumber(value: number | string | null): number | null {
  return value == null ? null : Number(value);
}

export async function readPhiServerAddonStorageUsage(
  pool: Pool,
  input: { addonId: string; siteId: number },
): Promise<PhiServerAddonStorageUsage> {
  const { rows } = await pool.query<{
    storage_used_bytes: string; storage_used_objects: number;
    storage_quota_bytes: string | null; storage_quota_objects: number | null;
  }>(
    `SELECT storage_used_bytes, storage_used_objects, storage_quota_bytes, storage_quota_objects
       FROM phis.site_server_addons
      WHERE addon_id = $1 AND site_id = $2`,
    [input.addonId, input.siteId],
  );
  const row = rows[0];
  return {
    bytes: asNumber(row?.storage_used_bytes ?? 0),
    objects: asNumber(row?.storage_used_objects ?? 0),
    quotaBytes: asNullableNumber(row?.storage_quota_bytes ?? null),
    quotaObjects: asNullableNumber(row?.storage_quota_objects ?? null),
  };
}

export type PhiServerAddonStorageBooking = {
  addonId: string;
  siteId: number;
  /** How the total changes. Negative when an object shrinks or goes away. */
  bytes: number;
  /** 1 for a key that did not exist, -1 for one being removed, 0 for an overwrite. */
  objects: number;
};

/**
 * Why a booking did not happen, because "it did not" is two different things.
 *
 * A store that is full and a store that does not exist need different words. Reporting both as full
 * sends an operator to raise a ceiling that was never the problem, and sends an Add-on author looking
 * for bytes that were never written -- the figures in such a message read "0 of unlimited", which is
 * nobody's idea of full.
 */
export type PhiServerAddonStorageBookingOutcome = "booked" | "over-quota" | "not-activated";

/**
 * Books a change against the ceiling, and answers whether it fits.
 *
 * A release is a booking with negative numbers and is never refused: the ceiling governs what may be
 * added, not what may be given back, and refusing a release would strand capacity that is no longer in
 * use. `GREATEST(0, ...)` is the floor -- a count that drifted below zero would silently grant free
 * space, so it is clamped rather than trusted.
 *
 * The row is looked for separately when the update matches nothing, which costs one statement on the
 * failing path only. Folding it into the first would mean returning the row when the quota refuses,
 * and then the successful path pays for the distinction instead.
 */
export async function bookPhiServerAddonStorage(
  pool: Pool,
  input: PhiServerAddonStorageBooking,
): Promise<PhiServerAddonStorageBookingOutcome> {
  const { rows } = await pool.query<{ addon_id: string }>(
    `UPDATE phis.site_server_addons
        SET storage_used_bytes = GREATEST(0, storage_used_bytes + $3),
            storage_used_objects = GREATEST(0, storage_used_objects + $4),
            updated_at = NOW()
      WHERE addon_id = $1 AND site_id = $2
        AND ($3 <= 0 OR storage_quota_bytes IS NULL OR storage_used_bytes + $3 <= storage_quota_bytes)
        AND ($4 <= 0 OR storage_quota_objects IS NULL OR storage_used_objects + $4 <= storage_quota_objects)
      RETURNING addon_id`,
    [input.addonId, input.siteId, input.bytes, input.objects],
  );
  if (rows.length > 0) {
    return "booked";
  }
  const { rows: present } = await pool.query<{ addon_id: string }>(
    `SELECT addon_id FROM phis.site_server_addons WHERE addon_id = $1 AND site_id = $2`,
    [input.addonId, input.siteId],
  );
  return present.length > 0 ? "over-quota" : "not-activated";
}

/**
 * Sets the ceilings, which only an operator does.
 *
 * `null` withdraws a ceiling rather than setting it to zero, and the two are different: zero is a store
 * that may hold nothing, none is a store nobody bounded. Answers false when the Add-on is not enabled
 * for this Site at all -- there is no row to bound, and quietly creating one would enable it.
 */
export async function setPhiServerAddonStorageQuota(
  pool: Pool,
  input: {
    addonId: string;
    siteId: number;
    quotaBytes?: number | null;
    quotaObjects?: number | null;
  },
): Promise<boolean> {
  const { rows } = await pool.query<{ addon_id: string }>(
    `UPDATE phis.site_server_addons
        SET storage_quota_bytes = CASE WHEN $3::boolean THEN $4::bigint ELSE storage_quota_bytes END,
            storage_quota_objects = CASE WHEN $5::boolean THEN $6::int ELSE storage_quota_objects END,
            updated_at = NOW()
      WHERE addon_id = $1 AND site_id = $2
      RETURNING addon_id`,
    [
      input.addonId,
      input.siteId,
      input.quotaBytes !== undefined,
      input.quotaBytes ?? null,
      input.quotaObjects !== undefined,
      input.quotaObjects ?? null,
    ],
  );
  return rows.length > 0;
}
