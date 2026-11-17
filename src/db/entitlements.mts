import { randomBytes } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  PhisEntitlementFlag,
  type PhisEntitlement,
  type PhisEntitlementState,
  type PhisEntitlementSubject,
} from "@phis/contracts/entitlements";
import type { PhisProductId } from "@phis/contracts/products";

import { withPoolTransaction } from "../lib/db-transaction.ts";
import { PHIS_ENTITLEMENT_SOURCE_FLAG_ALL_PRODUCTS, PHIS_PRODUCT_FLAG } from "../lib/constants/products.ts";
import { PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED } from "../lib/constants/server-addons.ts";
import { splitPhisProductId } from "../lib/addons/product-draft.ts";
import { ENTRY_PRODUCT_JOIN_SQL } from "./products.mts";

/** Pool or client alike: every read here is equally correct inside a caller's transaction and outside. */
type DbQueryable = Pick<PoolClient, "query">;

/**
 * Who is entitled to what (`entitlements:v1`, SERVER_ADDONS.md).
 *
 * Three tables. A **subject** is the reference Core hands out for one person on one Site, so no Add-on
 * holds a user id for this. An **entry** is one source's statement that a subject holds a product,
 * unique by the source's own reference, which is what makes stating it twice harmless. A **source** row
 * is the Site operator allowing a source to write, for every product or for the products of named
 * suppliers.
 *
 * Whether an entry counts is never stored. It follows from the two flags, the two instants and its
 * product -- which has to exist and not be locked -- read by the database's clock, so an entry that ends
 * tonight stops counting without anybody writing to it; the one thing an ending needs is its event,
 * which `announceEndedEntitlements` owes once per entry.
 */

/** An entry counts while neither flag is set, it has started, and it has not ended. */
const BLOCKING_FLAGS = PhisEntitlementFlag.Revoked | PhisEntitlementFlag.Suspended;
const VALID_SQL = `((e.flags & ${BLOCKING_FLAGS}) = 0 AND e.starts_at <= NOW() AND (e.ends_at IS NULL OR e.ends_at > NOW())
  AND EXISTS (SELECT 1 FROM phis.products vp WHERE ${ENTRY_PRODUCT_JOIN_SQL("e", "vp")} AND vp.state <> 'locked'))`;

const ENTRY_COLUMNS = `e.id, e.product, s.reference AS subject, e.source, e.reference, e.starts_at, e.ends_at,
  e.quantity, e.flags, ${VALID_SQL} AS valid, e.created_at, e.updated_at`;

type EntryRow = {
  id: number;
  product: string;
  subject: string;
  source: string;
  reference: string;
  starts_at: Date;
  ends_at: Date | null;
  quantity: number | null;
  flags: number;
  valid: boolean;
  created_at: Date;
  updated_at: Date;
};

function mapEntry(row: EntryRow): PhisEntitlement {
  return {
    id: row.id,
    product: row.product as PhisProductId,
    subject: row.subject,
    source: row.source,
    reference: row.reference,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    quantity: row.quantity,
    flags: row.flags,
    valid: row.valid,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** `sub_` and 24 characters of base 36: about 124 bits, which nobody guesses and nobody needs to read. */
function newSubjectReference(): PhisEntitlementSubject {
  let text = "";
  for (const byte of randomBytes(24)) {
    text += (byte % 36).toString(36);
  }
  return `sub_${text}`;
}

/** The subject of one person on one Site, issued on first asking and the same ever after. */
export async function ensureEntitlementSubject(db: Pool, siteId: number, userId: number): Promise<PhisEntitlementSubject> {
  await db.query(
    `INSERT INTO phis.entitlement_subjects (site_id, user_id, reference)
     VALUES ($1::smallint, $2::int, $3)
     ON CONFLICT (site_id, user_id) DO NOTHING`,
    [siteId, userId, newSubjectReference()],
  );
  const { rows } = await db.query<{ reference: string }>(
    `SELECT reference FROM phis.entitlement_subjects WHERE site_id = $1 AND user_id = $2`,
    [siteId, userId],
  );
  return rows[0]!.reference;
}

/** The row behind a reference, on this Site only: a reference of another Site is nobody here. */
export async function findEntitlementSubject(
  db: DbQueryable,
  siteId: number,
  reference: PhisEntitlementSubject,
): Promise<{ id: number; userId: number } | null> {
  const { rows } = await db.query<{ id: number; user_id: number }>(
    `SELECT id, user_id FROM phis.entitlement_subjects WHERE site_id = $1 AND reference = $2`,
    [siteId, reference],
  );
  return rows[0] ? { id: rows[0].id, userId: rows[0].user_id } : null;
}

/** The entries of a Site, narrowed to a subject, a product, or both; every source's, valid or not. */
export async function listEntitlements(pool: Pool, input: {
  siteId: number;
  subjectId?: number | null;
  product?: string | null;
}): Promise<PhisEntitlement[]> {
  const { rows } = await pool.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS}
     FROM phis.entitlements e
     JOIN phis.entitlement_subjects s ON s.id = e.subject_id
     WHERE e.site_id = $1
       AND ($2::int IS NULL OR e.subject_id = $2)
       AND ($3::text IS NULL OR e.product = $3)
     ORDER BY e.id ASC
     LIMIT 500`,
    [input.siteId, input.subjectId ?? null, input.product ?? null],
  );
  return rows.map(mapEntry);
}

/**
 * Whether a subject holds a product now.
 *
 * Whether quantities add up is the product's own word (its `Counted` bit). A product that does not exist
 * or is locked entitles nobody. `until` is the latest end among the valid entries and null as soon as
 * one of them has none.
 */
export async function readEntitlementState(pool: Pool, input: {
  siteId: number;
  subjectId: number | null;
  product: PhisProductId;
}): Promise<PhisEntitlementState> {
  if (input.subjectId === null) {
    return { product: input.product, entitled: false, quantity: null, until: null };
  }
  const { rows } = await pool.query<{ entries: string; quantity: string | null; open_ended: boolean; until: Date | null; counted: boolean }>(
    `SELECT COUNT(*) AS entries, SUM(e.quantity) AS quantity,
            COALESCE(BOOL_OR(e.ends_at IS NULL), FALSE) AS open_ended, MAX(e.ends_at) AS until,
            COALESCE(BOOL_OR((p.flags & ${PHIS_PRODUCT_FLAG.Counted}) <> 0), FALSE) AS counted
     FROM phis.entitlements e
     JOIN phis.products p ON ${ENTRY_PRODUCT_JOIN_SQL("e", "p")}
     WHERE e.site_id = $1 AND e.subject_id = $2 AND e.product = $3 AND ${VALID_SQL}`,
    [input.siteId, input.subjectId, input.product],
  );
  const row = rows[0]!;
  const entitled = Number(row.entries) > 0;
  return {
    product: input.product,
    entitled,
    quantity: entitled && row.counted ? Number(row.quantity ?? 0) : null,
    until: entitled && !row.open_ended && row.until ? row.until.toISOString() : null,
  };
}

/**
 * Owes `entitlement.changed` to the listeners named, for one subject and product.
 *
 * In the transaction of the change, like every outbox row. The listeners are the caller's reading of the
 * installed manifests; the insert keeps those asked for and configured on this Site.
 */
async function enqueueEntitlementChanged(
  db: DbQueryable,
  input: { siteId: number; recipients: readonly string[]; subject: PhisEntitlementSubject; product: string },
) {
  if (input.recipients.length === 0) {
    return;
  }
  await db.query(
    `INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, subject_kind, payload)
     SELECT $1::smallint, installed.addon_id, 'entitlement.changed', 'entitlement', $3::jsonb
     FROM phis.site_server_addons installed
     WHERE installed.site_id = $1
       AND installed.addon_id = ANY($2::text[])
       AND (installed.flags & ${PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED}) <> 0
       AND installed.configuration_status = 'ready'`,
    [input.siteId, input.recipients, JSON.stringify({ subject: input.subject, product: input.product })],
  );
}

async function readEntry(db: DbQueryable, id: number) {
  const { rows } = await db.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS}
     FROM phis.entitlements e
     JOIN phis.entitlement_subjects s ON s.id = e.subject_id
     WHERE e.id = $1`,
    [id],
  );
  return mapEntry(rows[0]!);
}

/**
 * A source's statement, written once.
 *
 * Idempotent on `(source, product, reference)`: the second call finds the first entry and answers it
 * unchanged, without an event, so a payment handler delivered twice entitles once -- also after the
 * product was withdrawn. A new entry needs its product to exist and be `active`, judged under a lock on
 * the product row so that it cannot be removed or moved between the check and the write; otherwise the
 * answer is null. `counted` is what the caller read the product to say, and is checked there again.
 */
export async function grantEntitlement(pool: Pool, input: {
  siteId: number;
  subjectId: number;
  product: PhisProductId;
  source: string;
  reference: string;
  startsAt: string | null;
  endsAt: string | null;
  quantity: number | null;
  counted: boolean;
  listeners: readonly string[];
}): Promise<PhisEntitlement | null> {
  return withPoolTransaction(pool, async (client) => {
    const find = () => client.query<{ id: number }>(
      `SELECT id FROM phis.entitlements WHERE site_id = $1 AND source = $2 AND product = $3 AND reference = $4`,
      [input.siteId, input.source, input.product, input.reference],
    );
    const existing = await find();
    if (existing.rows[0]) return readEntry(client, existing.rows[0].id);

    const { supplier, key } = splitPhisProductId(input.product);
    const { rows: held } = await client.query<{ state: string; flags: number }>(
      `SELECT state, flags FROM phis.products WHERE site_id = $1 AND supplier_addon_id = $2 AND key = $3 FOR SHARE`,
      [input.siteId, supplier, key],
    );
    if (!held[0] || held[0].state !== "active") return null;
    if (((held[0].flags & PHIS_PRODUCT_FLAG.Counted) !== 0) !== input.counted) {
      throw new Error(`${input.product} changed whether it counts while the entry was written; ask again.`);
    }
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO phis.entitlements (site_id, subject_id, product, source, reference, starts_at, ends_at, quantity)
       VALUES ($1::smallint, $2::int, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7::timestamptz, $8::int)
       ON CONFLICT (site_id, source, product, reference) DO NOTHING
       RETURNING id`,
      [input.siteId, input.subjectId, input.product, input.source, input.reference, input.startsAt, input.endsAt, input.quantity],
    );
    if (inserted.rows[0]) {
      const entry = await readEntry(client, inserted.rows[0].id);
      await enqueueEntitlementChanged(client, { siteId: input.siteId, recipients: input.listeners, subject: entry.subject, product: entry.product });
      return entry;
    }
    return readEntry(client, (await find()).rows[0]!.id);
  });
}

/**
 * Changes a source's own entry, found by the source's reference; null where it has none by that name.
 *
 * `undefined` leaves a column as it is, which is why the three are passed with a "stated" flag each: an
 * end of `null` is a statement -- without an end -- and not the absence of one. A revoked entry is over
 * and is not changed. An ending that moved is owed its event again.
 */
export async function updateEntitlement(pool: Pool, input: {
  siteId: number;
  source: string;
  product: PhisProductId;
  reference: string;
  endsAt?: string | null;
  quantity?: number | null;
  suspended?: boolean;
  revoke?: boolean;
  listeners: readonly string[];
}): Promise<PhisEntitlement | null> {
  return withPoolTransaction(pool, async (client) => {
    const updated = await client.query<{ id: number }>(
      `UPDATE phis.entitlements e
       SET ends_at = CASE WHEN $5::boolean THEN $6::timestamptz ELSE e.ends_at END,
           ended_event_at = CASE WHEN $5::boolean THEN NULL ELSE e.ended_event_at END,
           quantity = CASE WHEN $7::boolean THEN $8::int ELSE e.quantity END,
           flags = CASE
             WHEN $11::boolean THEN e.flags | ${PhisEntitlementFlag.Revoked}
             WHEN $9::boolean AND $10::boolean THEN e.flags | ${PhisEntitlementFlag.Suspended}
             WHEN $9::boolean THEN e.flags & ~${PhisEntitlementFlag.Suspended}
             ELSE e.flags
           END,
           updated_at = NOW()
       WHERE e.site_id = $1 AND e.source = $2 AND e.product = $3 AND e.reference = $4
         AND ($11::boolean OR (e.flags & ${PhisEntitlementFlag.Revoked}) = 0)
       RETURNING e.id`,
      [
        input.siteId, input.source, input.product, input.reference,
        input.endsAt !== undefined, input.endsAt ?? null,
        input.quantity !== undefined, input.quantity ?? null,
        input.suspended !== undefined, input.suspended === true,
        input.revoke === true,
      ],
    );
    if (!updated.rows[0]) {
      return null;
    }
    const entry = await readEntry(client, updated.rows[0].id);
    await enqueueEntitlementChanged(client, { siteId: input.siteId, recipients: input.listeners, subject: entry.subject, product: entry.product });
    return entry;
  });
}

/** Whether the Site's operator allowed this source to write the products of this supplier. */
export async function isEntitlementSourceAllowed(db: DbQueryable, siteId: number, supplier: string, source: string) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM phis.entitlement_sources
     WHERE site_id = $1 AND source = $2 AND ((flags & ${PHIS_ENTITLEMENT_SOURCE_FLAG_ALL_PRODUCTS}) <> 0 OR $3 = ANY(suppliers))`,
    [siteId, source, supplier],
  );
  return (rowCount ?? 0) > 0;
}

export type EntitlementSourceAllowance = {
  source: string;
  /** Every product of the Site; otherwise only those of `suppliers`. */
  allProducts: boolean;
  suppliers: string[];
  grantedByUserId: number | null;
  grantedAt: string;
};

export async function listEntitlementSources(db: DbQueryable, siteId: number): Promise<EntitlementSourceAllowance[]> {
  const { rows } = await db.query<{ source: string; flags: number; suppliers: string[]; granted_by_user_id: number | null; granted_at: Date }>(
    `SELECT source, flags, suppliers, granted_by_user_id, granted_at
     FROM phis.entitlement_sources
     WHERE site_id = $1
     ORDER BY source ASC`,
    [siteId],
  );
  return rows.map((row) => ({
    source: row.source,
    allProducts: (row.flags & PHIS_ENTITLEMENT_SOURCE_FLAG_ALL_PRODUCTS) !== 0,
    suppliers: row.suppliers,
    grantedByUserId: row.granted_by_user_id,
    grantedAt: row.granted_at.toISOString(),
  }));
}

/**
 * Allows a source to write on a Site: for every product (`suppliers` null) or for the products of exactly
 * the suppliers named, which replaces what was allowed before. Saying the same twice changes nothing.
 */
export async function allowEntitlementSource(pool: Pool, input: {
  siteId: number;
  source: string;
  suppliers: readonly string[] | null;
  grantedByUserId: number | null;
}) {
  const { rowCount } = await pool.query(
    `INSERT INTO phis.entitlement_sources (site_id, source, flags, suppliers, granted_by_user_id)
     VALUES ($1::smallint, $2, $3::int, $4::text[], $5::int)
     ON CONFLICT (site_id, source) DO UPDATE
       SET flags = EXCLUDED.flags, suppliers = EXCLUDED.suppliers,
           granted_by_user_id = EXCLUDED.granted_by_user_id, granted_at = NOW()
       WHERE (phis.entitlement_sources.flags, phis.entitlement_sources.suppliers) IS DISTINCT FROM (EXCLUDED.flags, EXCLUDED.suppliers)`,
    [input.siteId, input.source, input.suppliers === null ? PHIS_ENTITLEMENT_SOURCE_FLAG_ALL_PRODUCTS : 0,
      input.suppliers === null ? [] : [...input.suppliers].sort(), input.grantedByUserId],
  );
  return (rowCount ?? 0) > 0;
}

/** Takes the leave back. The entries the source wrote stay: they are statements about the past. */
export async function disallowEntitlementSource(pool: Pool, input: { siteId: number; source: string }) {
  const { rowCount } = await pool.query(
    `DELETE FROM phis.entitlement_sources WHERE site_id = $1 AND source = $2`,
    [input.siteId, input.source],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Owes the event of every entry that has ended since the last run, once each.
 *
 * An ending is the one change nobody writes. The listeners are the caller's reading of the installed
 * manifests, the same for every Site; the insert narrows them to each Site's own. The mark and the outbox
 * rows are one transaction, so an entry is announced or still owed, never lost.
 * Answers the Sites that now have something to deliver.
 */
export async function announceEndedEntitlements(pool: Pool, listeners: readonly string[]): Promise<number[]> {
  return withPoolTransaction(pool, async (client) => {
    const { rows } = await client.query<{ site_id: number; subject: string; product: string }>(
      `UPDATE phis.entitlements e
       SET ended_event_at = NOW()
       FROM phis.entitlement_subjects s
       WHERE s.id = e.subject_id
         AND e.ends_at IS NOT NULL AND e.ends_at <= NOW()
         AND e.ended_event_at IS NULL
         AND (e.flags & ${PhisEntitlementFlag.Revoked}) = 0
       RETURNING e.site_id, s.reference AS subject, e.product`,
    );
    const said = new Set<string>();
    for (const row of rows) {
      // Two entries of one subject and product ending together change one answer once.
      const key = `${row.site_id}|${row.subject}|${row.product}`;
      if (said.has(key)) continue;
      said.add(key);
      await enqueueEntitlementChanged(client, { siteId: row.site_id, recipients: listeners, subject: row.subject, product: row.product });
    }
    return [...new Set(rows.map((row) => row.site_id))];
  });
}
