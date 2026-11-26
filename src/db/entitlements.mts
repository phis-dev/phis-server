import { randomUUID } from "node:crypto";

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
import { newEntitlementSubjectReference } from "./entitlement-subject-reference.mts";

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
/**
 * What an entry bound to a subscription follows, read from the subscription's record on every use.
 * `period` is the latest paid period, null until the first payment: such an entry counts for nothing.
 * It counts until that period's end, and -- while the subscription has not ended -- for the Site's grace
 * days after it (`BOUND_COUNTS_UNTIL_SQL`). The end the entry shows is the period's, without the grace.
 */
const PAID_END_SQL = `(SELECT (sx.record->'period'->>'endsAt')::timestamptz FROM phis.payment_subscriptions sx WHERE sx.id = e.subscription_id)`;
const BOUND_COUNTS_UNTIL_SQL = `(SELECT (sx.record->'period'->>'endsAt')::timestamptz
  + CASE WHEN sx.record->>'status' = 'canceled' OR sx.record->>'endedAt' IS NOT NULL THEN 0
         ELSE (SELECT g.entitlement_grace_days FROM phis.sites g WHERE g.id = e.site_id) END * INTERVAL '1 day'
  FROM phis.payment_subscriptions sx WHERE sx.id = e.subscription_id)`;
const SHOWN_END_SQL = `COALESCE(e.ends_at, ${PAID_END_SQL})`;
/** An entry that never stops counting: one without a subscription and without a written end. */
const OPEN_ENDED_SQL = `(e.subscription_id IS NULL AND e.ends_at IS NULL)`;
/**
 * The instant an entry stops counting, the one rule behind `valid`, the state's `until` and the expiry
 * job: an unbound entry's written end, a bound one's `BOUND_COUNTS_UNTIL_SQL`. Null for an open-ended
 * entry, and for a bound one without a paid period, which counts for nothing.
 */
const COUNTS_UNTIL_SQL = `(CASE WHEN e.subscription_id IS NULL THEN e.ends_at ELSE ${BOUND_COUNTS_UNTIL_SQL} END)`;

const VALID_SQL = `((e.flags & ${BLOCKING_FLAGS}) = 0 AND e.starts_at <= NOW()
  AND (${OPEN_ENDED_SQL} OR COALESCE(${COUNTS_UNTIL_SQL} > NOW(), FALSE))
  AND EXISTS (SELECT 1 FROM phis.products vp WHERE ${ENTRY_PRODUCT_JOIN_SQL("e", "vp")} AND vp.state <> 'locked'))`;

const ENTRY_COLUMNS = `e.id, e.product, s.reference AS subject, e.source, e.reference, e.starts_at, ${SHOWN_END_SQL} AS ends_at, e.subscription_id::text AS subscription_id,
  e.quantity, e.flags, ${VALID_SQL} AS valid, e.created_at, e.updated_at`;

/**
 * The products whose entries speak for each product in `products` (a `text[]`) of the Site in `site`: the
 * product itself and every bundle that contains it through the `parts` in force, directly or through
 * nested bundles (a bundle's holder holds its parts), each row keeping the product it was reached from
 * (`asked`), so one walk answers for several products. `passing` narrows the walk to products that pass a
 * holding on -- not locked -- for the answer; the plain walk is for listing entries, valid or not. Parts are
 * kept acyclic by the product directory, and `UNION` would end the walk regardless.
 */
const holdersSql = (site: string, products: string, passing: boolean) => {
  const unlocked = (alias: string) => (passing ? ` AND ${alias}.state <> 'locked'` : "");
  const start = passing
    ? `SELECT a.product, a.product FROM (SELECT DISTINCT unnest(${products}) AS product) a
       WHERE EXISTS (SELECT 1 FROM phis.products tp WHERE tp.site_id = ${site}
         AND tp.supplier_addon_id = regexp_replace(a.product, ':[^:]+$', '') AND tp.key = substring(a.product from '[^:]+$')${unlocked("tp")})`
    : `SELECT a.product, a.product FROM (SELECT DISTINCT unnest(${products}) AS product) a`;
  return `holders(asked, product) AS (
       ${start}
       UNION
       SELECT h.asked, b.supplier_addon_id || ':' || b.key
       FROM holders h
       JOIN phis.products b ON b.site_id = ${site} AND h.product = ANY(b.parts)${unlocked("b")}
     )`;
};

type EntryRow = {
  id: number;
  product: string;
  subject: string;
  source: string;
  reference: string;
  starts_at: Date;
  ends_at: Date | null;
  subscription_id: string | null;
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
    subscriptionId: row.subscription_id,
    quantity: row.quantity,
    flags: row.flags,
    valid: row.valid,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The subject of one person on one Site, issued on first asking and the same ever after. */
export async function ensureEntitlementSubject(db: Pool, siteId: number, userId: number): Promise<PhisEntitlementSubject> {
  await db.query(
    `INSERT INTO phis.entitlement_subjects (site_id, user_id, reference)
     VALUES ($1::smallint, $2::int, $3)
     ON CONFLICT (site_id, user_id) DO NOTHING`,
    [siteId, userId, newEntitlementSubjectReference()],
  );
  const { rows } = await db.query<{ reference: string }>(
    `SELECT reference FROM phis.entitlement_subjects WHERE site_id = $1 AND user_id = $2`,
    [siteId, userId],
  );
  return rows[0]!.reference;
}

/**
 * The subject of a member of the Site, issued on first asking as `ensureEntitlementSubject` issues it;
 * null for a user who is not a member, who is issued none. For staff acting on a person's behalf
 * (`entitlements:v1` `subjectForUser`); whether they may is the caller's question.
 */
export async function ensureMemberEntitlementSubject(db: Pool, siteId: number, userId: number): Promise<PhisEntitlementSubject | null> {
  const member = `EXISTS (SELECT 1 FROM phis.user_site_memberships m WHERE m.site_id = $1 AND m.user_id = $2)`;
  await db.query(
    `INSERT INTO phis.entitlement_subjects (site_id, user_id, reference)
     SELECT $1::smallint, $2::int, $3 WHERE ${member}
     ON CONFLICT (site_id, user_id) DO NOTHING`,
    [siteId, userId, newEntitlementSubjectReference()],
  );
  const { rows } = await db.query<{ reference: string }>(
    `SELECT s.reference FROM phis.entitlement_subjects s WHERE s.site_id = $1 AND s.user_id = $2 AND ${member}`,
    [siteId, userId],
  );
  return rows[0]?.reference ?? null;
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

/**
 * The entries of a Site, narrowed to a subject, a product, or both; every source's, valid or not.
 * `subjectReferences` narrows to several subjects at once by their references, in the same one
 * statement -- a reference that is nobody on this Site matches no entry of it.
 *
 * `resolveBundles` with a product also lists the entries on every bundle that contains it, directly or
 * through nested bundles and whatever their state, each as it is. Without a product it changes nothing.
 */
export async function listEntitlements(pool: Pool, input: {
  siteId: number;
  subjectId?: number | null;
  subjectReferences?: readonly PhisEntitlementSubject[] | null;
  product?: string | null;
  resolveBundles?: boolean;
}): Promise<PhisEntitlement[]> {
  const product = input.product ?? null;
  const bundles = product !== null && input.resolveBundles === true;
  const { rows } = await pool.query<EntryRow>(
    `${bundles ? `WITH RECURSIVE ${holdersSql("$1::smallint", "ARRAY[$3::text]", false)}` : ""}
     SELECT ${ENTRY_COLUMNS}
     FROM phis.entitlements e
     JOIN phis.entitlement_subjects s ON s.id = e.subject_id
     WHERE e.site_id = $1
       AND ($2::int IS NULL OR e.subject_id = $2)
       AND ($4::text[] IS NULL OR s.reference = ANY($4::text[]))
       AND ${bundles ? "e.product IN (SELECT product FROM holders)" : "($3::text IS NULL OR e.product = $3)"}
     ORDER BY e.id ASC
     LIMIT 500`,
    [input.siteId, input.subjectId ?? null, product, input.subjectReferences ?? null],
  );
  return rows.map(mapEntry);
}

/**
 * Whether a subject holds a product now.
 *
 * The entries that count are the valid ones on the product and on every bundle that contains it, directly
 * or through nested bundles: a bundle's holder holds its parts. A product that does not exist or is
 * locked entitles nobody and passes nothing on, so a locked part is held through no bundle and a locked
 * bundle gives none of its parts. `until` is the latest instant at which one of those entries stops
 * counting -- `COUNTS_UNTIL_SQL`, the rule `valid` follows, so for a bound entry its paid period's end plus
 * the grace and not the `endsAt` it shows -- and null as soon as one of them has no end; `via` names the products whose entries they are, the product itself first. Whether
 * quantities add up is the product's own word (its `Counted` bit), and only its own entries are summed --
 * a bundle is never counted. One round trip; `readEntitlementStates` for one product.
 */
export async function readEntitlementState(pool: Pool, input: {
  siteId: number;
  subjectId: number | null;
  product: PhisProductId;
}): Promise<PhisEntitlementState> {
  return (await readEntitlementStates(pool, { siteId: input.siteId, subjectId: input.subjectId, products: [input.product] }))[0]!;
}

/**
 * `readEntitlementState` for several products in one round trip: one answer per product asked for, in the
 * order asked, a product asked twice answered twice. The walk to the bundles starts from every product
 * asked for at once and keeps which one it started from (`holders.asked`), so each answer is the one its
 * own read would give. The caller bounds the list (`entitlements:v1` `checkMany`, at most 100).
 */
export async function readEntitlementStates(pool: Pool, input: {
  siteId: number;
  subjectId: number | null;
  products: readonly PhisProductId[];
}): Promise<PhisEntitlementState[]> {
  const nobody = (product: PhisProductId): PhisEntitlementState => ({ product, entitled: false, quantity: null, until: null, via: [] });
  if (input.subjectId === null || input.products.length === 0) {
    return input.products.map(nobody);
  }
  const { rows } = await pool.query<{
    product: string; entries: string | null; quantity: string | null; open_ended: boolean | null; until: Date | null; via: string[] | null; counted: boolean;
  }>(
    `WITH RECURSIVE ${holdersSql("$1::smallint", "$3::text[]", true)},
     held AS (
       SELECT h.asked, COUNT(*) AS entries, SUM(e.quantity) FILTER (WHERE e.product = h.asked) AS quantity,
              BOOL_OR(${OPEN_ENDED_SQL}) AS open_ended, MAX(${COUNTS_UNTIL_SQL}) AS until,
              ARRAY_AGG(DISTINCT e.product) AS via
       FROM holders h
       JOIN phis.entitlements e ON e.site_id = $1 AND e.subject_id = $2 AND e.product = h.product
       WHERE ${VALID_SQL}
       GROUP BY h.asked
     )
     SELECT a.product, held.entries, held.quantity, held.open_ended, held.until, held.via,
            COALESCE((cp.flags & ${PHIS_PRODUCT_FLAG.Counted}) <> 0, FALSE) AS counted
     FROM (SELECT DISTINCT unnest($3::text[]) AS product) a
     LEFT JOIN held ON held.asked = a.product
     LEFT JOIN phis.products cp ON cp.site_id = $1 AND cp.supplier_addon_id = regexp_replace(a.product, ':[^:]+$', '')
       AND cp.key = substring(a.product from '[^:]+$')`,
    [input.siteId, input.subjectId, input.products],
  );
  const byProduct = new Map(rows.map((row) => [row.product, row]));
  return input.products.map((product) => {
    const row = byProduct.get(product);
    const entitled = row !== undefined && Number(row.entries ?? 0) > 0;
    if (!row || !entitled) return nobody(product);
    const via = row.via ?? [];
    const own = via.includes(product);
    const bundles = via.filter((id) => id !== product).sort();
    return {
      product,
      entitled,
      quantity: row.counted ? Number(row.quantity ?? 0) : null,
      until: !row.open_ended && row.until ? row.until.toISOString() : null,
      via: (own ? [product, ...bundles] : bundles) as PhisProductId[],
    };
  });
}

/**
 * Owes `entitlement.changed` to the listeners named, for one subject and the products whose entries changed.
 *
 * An entry on a bundle changes the answer for its parts too, so every part -- through the `parts` in
 * force, directly or through nested bundles, whatever their state -- is owed the event as well, once per
 * product however many of `products` lead to it. A part may be another supplier's; the recipients are the
 * same, every listener. In the transaction of the change, like every outbox row. The listeners are the
 * caller's reading of the installed manifests; the insert keeps those asked for and configured on this
 * Site.
 */
async function enqueueEntitlementChanged(
  db: DbQueryable,
  input: { siteId: number; recipients: readonly string[]; subject: PhisEntitlementSubject; products: readonly string[] },
) {
  if (input.recipients.length === 0 || input.products.length === 0) {
    return;
  }
  await db.query(
    `WITH RECURSIVE reach(product) AS (
       SELECT unnest($4::text[])
       UNION
       SELECT part.product
       FROM reach r
       JOIN phis.products b ON b.site_id = $1
         AND b.supplier_addon_id = regexp_replace(r.product, ':[^:]+$', '') AND b.key = substring(r.product from '[^:]+$')
       CROSS JOIN LATERAL unnest(b.parts) AS part(product)
     )
     INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, subject_kind, payload)
     SELECT $1::smallint, installed.addon_id, 'entitlement.changed', 'entitlement', jsonb_build_object('subject', $3::text, 'product', reach.product)
     FROM reach
     CROSS JOIN phis.site_server_addons installed
     WHERE installed.site_id = $1
       AND installed.addon_id = ANY($2::text[])
       AND (installed.flags & ${PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED}) <> 0
       AND installed.configuration_status = 'ready'
     ORDER BY reach.product = ANY($4::text[]) DESC, reach.product COLLATE "C", installed.addon_id`,
    [input.siteId, input.recipients, input.subject, input.products],
  );
}

/**
 * Owes `entitlement.changed` once more to one Add-on, for every subject that holds `product` on the Site now
 * (`entitlements:v1` `redeliver`): an Add-on that starts acting on a product only later catches up through
 * its own handler.
 *
 * The holders are the walk `readEntitlementStates` answers with -- the product itself, unlocked, and every
 * unlocked bundle that contains it -- and the valid entries on any of them, one row per subject. The event
 * names `product` and not the bundle an entry is on, because what the handler asks next is whether the
 * subject holds `product`. One `INSERT ... SELECT`: the subjects never pass through this process, however
 * many there are, and the dispatcher hands them on in its own batches. The rows are addressed to
 * `addonId` alone, as every outbox row is to one Add-on, so no other listener hears of it.
 *
 * A call while an earlier one for the same Add-on, product and Site is still owed queues nothing: those
 * rows carry `redelivery` (the id of the call that wrote them) in their payload, and one pending row of them
 * is enough to answer 0. The advisory lock makes two calls at once take turns at that question. Answers how
 * many subjects were queued; the caller checks who may ask.
 */
export async function redeliverEntitlementChanged(pool: Pool, input: {
  siteId: number;
  addonId: string;
  product: PhisProductId;
}): Promise<number> {
  return withPoolTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify(["entitlement-redelivery", input.siteId, input.addonId, input.product])]);
    const { rowCount } = await client.query(
      `WITH RECURSIVE ${holdersSql("$1::smallint", "ARRAY[$3::text]", true)}
       INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, subject_kind, payload)
       SELECT $1::smallint, installed.addon_id, 'entitlement.changed', 'entitlement',
              jsonb_build_object('subject', s.reference, 'product', $3::text, 'redelivery', $4::text)
       FROM phis.entitlement_subjects s
       JOIN phis.site_server_addons installed
         ON installed.site_id = $1 AND installed.addon_id = $2
        AND (installed.flags & ${PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED}) <> 0
        AND installed.configuration_status = 'ready'
       WHERE s.site_id = $1
         AND EXISTS (
           SELECT 1 FROM holders h
           JOIN phis.entitlements e ON e.site_id = $1 AND e.subject_id = s.id AND e.product = h.product
           WHERE ${VALID_SQL}
         )
         AND NOT EXISTS (
           SELECT 1 FROM phis.addon_event_outbox pending
           WHERE pending.addon_id = $2 AND pending.site_id = $1 AND pending.delivered_at IS NULL
             AND pending.event = 'entitlement.changed' AND pending.payload ? 'redelivery'
             AND pending.payload->>'product' = $3::text
         )
       ORDER BY s.id`,
      [input.siteId, input.addonId, input.product, randomUUID()],
    );
    return rowCount ?? 0;
  });
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
  /** A subscription of this source, which has no written end. The caller has checked it is the source's own. */
  subscriptionId?: string | null;
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
      `INSERT INTO phis.entitlements (site_id, subject_id, product, source, reference, starts_at, ends_at, quantity, subscription_id)
       VALUES ($1::smallint, $2::int, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7::timestamptz, $8::int, $9::uuid)
       ON CONFLICT (site_id, source, product, reference) DO NOTHING
       RETURNING id`,
      [input.siteId, input.subjectId, input.product, input.source, input.reference, input.startsAt, input.endsAt, input.quantity, input.subscriptionId ?? null],
    );
    if (inserted.rows[0]) {
      const entry = await readEntry(client, inserted.rows[0].id);
      await enqueueEntitlementChanged(client, { siteId: input.siteId, recipients: input.listeners, subject: entry.subject, products: [entry.product] });
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
    if (input.endsAt !== undefined) {
      const { rowCount } = await client.query(
        `SELECT 1 FROM phis.entitlements WHERE site_id = $1 AND source = $2 AND product = $3 AND reference = $4 AND subscription_id IS NOT NULL`,
        [input.siteId, input.source, input.product, input.reference],
      );
      if ((rowCount ?? 0) > 0) throw new Error("An entry bound to a subscription has no written end; its subscription decides.");
    }
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
    await enqueueEntitlementChanged(client, { siteId: input.siteId, recipients: input.listeners, subject: entry.subject, products: [entry.product] });
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
    /*
     * A written end is announced once and a moved one again (`ended_event_at` is cleared with it). A bound
     * entry's end moves by itself when the subscription is renewed, so it is announced when its
     * `ended_event_at` is older than the instant it counts until: after a renewal the next expiry is later
     * than the last announcement and is owed again, and one announcement serves one expiry. Both branches
     * are `COUNTS_UNTIL_SQL` spelled out per kind, so each reaches its own partial index.
     */
    const { rows } = await client.query<{ site_id: number; subject: string; product: string }>(
      `UPDATE phis.entitlements e
       SET ended_event_at = NOW()
       FROM phis.entitlement_subjects s
       WHERE s.id = e.subject_id
         AND (e.flags & ${PhisEntitlementFlag.Revoked}) = 0
         AND (
           (e.subscription_id IS NULL AND e.ends_at IS NOT NULL AND e.ends_at <= NOW() AND e.ended_event_at IS NULL)
           OR (e.subscription_id IS NOT NULL AND ${BOUND_COUNTS_UNTIL_SQL} <= NOW()
               AND (e.ended_event_at IS NULL OR e.ended_event_at < ${BOUND_COUNTS_UNTIL_SQL}))
         )
       RETURNING e.site_id, s.reference AS subject, e.product`,
    );
    // Two entries of one subject ending together change each answer once: the products are gathered per
    // Site and subject, and the parts they lead to are counted once among them.
    const ended = new Map<string, { siteId: number; subject: string; products: Set<string> }>();
    for (const row of rows) {
      const key = `${row.site_id}|${row.subject}`;
      const group = ended.get(key) ?? { siteId: row.site_id, subject: row.subject, products: new Set<string>() };
      group.products.add(row.product);
      ended.set(key, group);
    }
    for (const group of ended.values()) {
      await enqueueEntitlementChanged(client, { siteId: group.siteId, recipients: listeners, subject: group.subject, products: [...group.products] });
    }
    return [...new Set(rows.map((row) => row.site_id))];
  });
}

/** Whether the subscription exists on the Site and was created by this Add-on: a subscription belongs to its consumer. */
export async function isSubscriptionOfAddon(db: DbQueryable, siteId: number, subscriptionId: string, addonId: string) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM phis.payment_subscriptions WHERE site_id = $1 AND id::text = $2 AND consumer_addon_id = $3`,
    [siteId, subscriptionId, addonId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Owes `entitlement.changed`, once per subject and product -- the parts of a bundle among them -- for the
 * unrevoked entries that follow a subscription. Called inside the transaction in which payments changes the subscription; `listeners` is
 * read only when there is something to announce.
 */
export async function announceSubscriptionEntitlements(db: DbQueryable, input: {
  siteId: number;
  subscriptionId: string;
  listeners: () => readonly string[];
}) {
  const { rows } = await db.query<{ subject: string; product: string }>(
    `SELECT DISTINCT s.reference AS subject, e.product
     FROM phis.entitlements e JOIN phis.entitlement_subjects s ON s.id = e.subject_id
     WHERE e.subscription_id::text = $1 AND (e.flags & ${PhisEntitlementFlag.Revoked}) = 0`,
    [input.subscriptionId],
  );
  if (rows.length === 0) return;
  const recipients = input.listeners();
  const bySubject = new Map<string, string[]>();
  for (const row of rows) bySubject.set(row.subject, [...bySubject.get(row.subject) ?? [], row.product]);
  for (const [subject, products] of bySubject) {
    await enqueueEntitlementChanged(db, { siteId: input.siteId, recipients, subject, products });
  }
}
