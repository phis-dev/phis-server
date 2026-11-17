import type { Pool, PoolClient } from "pg";

import type {
  PhisProduct,
  PhisProductId,
  PhisProductListInput,
  PhisProductReleasedTerms,
  PhisProductSale,
  PhisProductState,
} from "@phis/contracts/products";

import { PHIS_PRODUCT_FLAG } from "../lib/constants/products.ts";
import { PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED, PHIS_ADDON_FLAG_GLOBALLY_ENABLED } from "../lib/constants/server-addons.ts";
import { withPoolTransaction } from "../lib/db-transaction.ts";
import { splitPhisProductId, type PhisNormalizedProductDraft } from "../lib/addons/product-draft.ts";

/** Pool or client alike: every read here is equally correct inside a caller's transaction and outside. */
type DbQueryable = Pick<PoolClient, "query">;

/**
 * The Site's product directory (`products:v1`, SERVER_ADDONS.md; design/COMMERCE_COORDINATION.md
 * section 4).
 *
 * Two tables: a **product** is an identity -- who supplies it, what it is called, whether it can be
 * acquired -- and an **attributes** row is what one other Add-on attached to it. Every change that a
 * seller or a showcase has to learn of writes its `product.changed` outbox row in the same transaction.
 * The listeners are the caller's reading of the installed manifests; the insert narrows them to the
 * Add-ons configured on the Site.
 */

/**
 * A product as the database holds it. `imagePath` is not here: Core's address of a Media Asset is built
 * where the Media delivery lives (`resolvePhiMediaDeliveryUrl`), from the asset's current cache revision
 * carried here, and never stored.
 */
export type PhisStoredProduct = Omit<PhisProduct, "imagePath"> & { readonly imageRevision: number | null };

/** A rule the product directory enforces; the message says which, for the Add-on or the operator. */
export class PhisProductRuleError extends Error {}

const FLAG = PHIS_PRODUCT_FLAG;

const PRODUCT_COLUMNS = `p.id, p.supplier_addon_id, p.key, p.publisher, p.type, p.title, p.summary, p.image_asset_id,
  p.sale, p.referral_url, p.state, p.flags, p.parts, p.pending_terms, p.version, p.created_at, p.updated_at,
  ${suppliedSql("p")} AS supplied,
  (SELECT a.delivery_revision FROM phis.media_assets a WHERE a.id = p.image_asset_id AND a.site_id = p.site_id) AS image_revision`;

/**
 * Whether the supplier is switched on for the product's Site and globally. The one predicate behind
 * `supplied`, the withdrawal and the restore, so what is reported is what Core acts on.
 */
function suppliedSql(alias: string) {
  return `EXISTS (
    SELECT 1 FROM phis.site_server_addons s
    JOIN phis.server_addons a ON a.addon_id = s.addon_id
    WHERE s.site_id = ${alias}.site_id AND s.addon_id = ${alias}.supplier_addon_id
      AND (s.flags & ${PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED}) <> 0
      AND (a.flags & ${PHIS_ADDON_FLAG_GLOBALLY_ENABLED}) <> 0)`;
}

/** The product an entitlement entry `e` names; the entry carries the id, the table its two halves. */
export const ENTRY_PRODUCT_JOIN_SQL = (entry: string, product: string) =>
  `${product}.site_id = ${entry}.site_id
   AND ${product}.supplier_addon_id = regexp_replace(${entry}.product, ':[^:]+$', '')
   AND ${product}.key = substring(${entry}.product from '[^:]+$')`;

type ProductRow = {
  id: number;
  supplier_addon_id: string;
  key: string;
  publisher: string | null;
  type: string;
  title: string;
  summary: string;
  image_asset_id: number | null;
  sale: PhisProductSale;
  referral_url: string | null;
  state: PhisProductState;
  flags: number;
  parts: string[];
  pending_terms: PhisProductReleasedTerms | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  supplied: boolean;
  image_revision: number | null;
};

function mapProduct(row: ProductRow, attributes: Record<string, Record<string, unknown>>): PhisStoredProduct {
  return {
    id: `${row.supplier_addon_id}:${row.key}` as PhisProductId,
    supplier: row.supplier_addon_id,
    supplied: row.supplied,
    publisher: row.publisher,
    type: row.type,
    title: row.title,
    summary: row.summary,
    imageAssetId: row.image_asset_id,
    imageRevision: row.image_revision,
    counted: (row.flags & FLAG.Counted) !== 0,
    sale: row.sale,
    referralUrl: row.referral_url,
    free: (row.flags & FLAG.Free) !== 0,
    parts: row.parts as PhisProductId[],
    state: row.state,
    released: row.publisher === null || (row.flags & FLAG.Released) !== 0,
    pendingTerms: row.pending_terms,
    attributes,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadAttributes(db: DbQueryable, ids: readonly number[]) {
  const byProduct = new Map<number, Record<string, Record<string, unknown>>>();
  if (ids.length === 0) return byProduct;
  const { rows } = await db.query<{ product_id: number; addon_id: string; data: Record<string, unknown> }>(
    `SELECT product_id, addon_id, data FROM phis.product_attributes WHERE product_id = ANY($1::int[]) ORDER BY addon_id`,
    [ids],
  );
  for (const row of rows) {
    const entry = byProduct.get(row.product_id) ?? {};
    entry[row.addon_id] = row.data;
    byProduct.set(row.product_id, entry);
  }
  return byProduct;
}

async function mapProducts(db: DbQueryable, rows: readonly ProductRow[]) {
  const attributes = await loadAttributes(db, rows.map((row) => row.id));
  return rows.map((row) => mapProduct(row, attributes.get(row.id) ?? {}));
}

async function selectRow(db: DbQueryable, siteId: number, id: PhisProductId, lock = false) {
  const { supplier, key } = splitPhisProductId(id);
  const { rows } = await db.query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM phis.products p
     WHERE p.site_id = $1 AND p.supplier_addon_id = $2 AND p.key = $3${lock ? " FOR UPDATE OF p" : ""}`,
    [siteId, supplier, key],
  );
  return rows[0] ?? null;
}

export async function readProduct(db: DbQueryable, siteId: number, id: PhisProductId): Promise<PhisStoredProduct | null> {
  const row = await selectRow(db, siteId, id);
  return row ? (await mapProducts(db, [row]))[0]! : null;
}

export type ProductListFilter = Pick<PhisProductListInput, "supplier" | "publisher" | "type" | "states" | "released" | "ids">;

/**
 * One page of a Site's products, by id. A cursor is the last id of the previous page, opaque to the
 * caller; the limit is the caller's reading of the contract (at most 200, default 50).
 */
export async function listProducts(db: DbQueryable, input: ProductListFilter & {
  siteId: number;
  states: readonly PhisProductState[];
  cursor: string | null;
  limit: number;
}): Promise<{ products: PhisStoredProduct[]; nextCursor: string | null }> {
  const afterId = decodeCursor(input.cursor);
  const { rows } = await db.query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM phis.products p
     WHERE p.site_id = $1
       AND p.state = ANY($2::text[])
       AND ($3::text IS NULL OR p.supplier_addon_id = $3)
       AND ($4::text IS NULL OR p.publisher = $4)
       AND ($5::text IS NULL OR p.type = $5)
       AND ($6::boolean IS NULL
         OR ($6 AND (p.publisher IS NULL OR (p.flags & ${FLAG.Released}) <> 0))
         OR (NOT $6 AND ((p.publisher IS NOT NULL AND (p.flags & ${FLAG.Released}) = 0) OR p.pending_terms IS NOT NULL)))
       AND ($9::text[] IS NULL OR p.supplier_addon_id || ':' || p.key = ANY($9::text[]))
       AND p.id > $7::int
     ORDER BY p.id ASC
     LIMIT $8::int`,
    [input.siteId, input.states, input.supplier ?? null, input.publisher ?? null, input.type ?? null,
      input.released ?? null, afterId, input.limit + 1, input.ids ?? null],
  );
  const page = rows.slice(0, input.limit);
  const products = await mapProducts(db, page);
  return { products, nextCursor: rows.length > input.limit ? encodeCursor(page[page.length - 1]!.id) : null };
}

const CURSOR_PREFIX = "p1.";
function encodeCursor(id: number) {
  return `${CURSOR_PREFIX}${Buffer.from(String(id)).toString("base64url")}`;
}
function decodeCursor(cursor: string | null) {
  if (cursor === null) return 0;
  const text = cursor.startsWith(CURSOR_PREFIX) ? Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString() : "";
  if (!/^\d{1,9}$/.test(text)) throw new PhisProductRuleError("The cursor is not one this directory handed out.");
  return Number(text);
}

/**
 * Owes `product.changed` to the listeners named, for one product.
 *
 * In the transaction of the change, like every outbox row; the insert keeps those asked for and
 * configured on this Site.
 */
async function enqueueProductChanged(
  db: DbQueryable,
  input: { siteId: number; recipients: readonly string[]; productId: string },
) {
  if (input.recipients.length === 0) return;
  await db.query(
    `INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, subject_kind, payload)
     SELECT $1::smallint, installed.addon_id, 'product.changed', 'product', $3::jsonb
     FROM phis.site_server_addons installed
     WHERE installed.site_id = $1
       AND installed.addon_id = ANY($2::text[])
       AND (installed.flags & ${PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED}) <> 0
       AND installed.configuration_status = 'ready'`,
    [input.siteId, input.recipients, JSON.stringify({ productId: input.productId })],
  );
}

/** Every part is a product of the Site, and nothing reaches the product again through its parts. */
async function assertParts(db: DbQueryable, siteId: number, ownId: PhisProductId, parts: readonly string[]) {
  if (parts.length === 0) return;
  const { rows: found } = await db.query<{ id: string }>(
    `SELECT supplier_addon_id || ':' || key AS id FROM phis.products
     WHERE site_id = $1 AND supplier_addon_id || ':' || key = ANY($2::text[])`,
    [siteId, parts],
  );
  const present = new Set(found.map((row) => row.id));
  const missing = parts.find((part) => !present.has(part));
  if (missing) throw new PhisProductRuleError(`${missing} is not a product of this Site; a part is a product that exists.`);
  // The pending parts of a product count as well: they are what it becomes at its release.
  const { rows: circle } = await db.query(
    `WITH RECURSIVE reach(id) AS (
       SELECT unnest($3::text[])
       UNION
       SELECT t.id
       FROM reach r
       JOIN phis.products p ON p.site_id = $1 AND p.supplier_addon_id || ':' || p.key = r.id
       CROSS JOIN LATERAL unnest(p.parts || ARRAY(SELECT jsonb_array_elements_text(COALESCE(p.pending_terms->'parts', '[]'::jsonb)))) AS t(id)
     )
     SELECT 1 FROM reach WHERE id = $2 LIMIT 1`,
    [siteId, ownId, parts],
  );
  if (circle.length > 0) throw new PhisProductRuleError(`${ownId} would contain itself through its parts.`);
}

async function isNamedByEntitlement(db: DbQueryable, siteId: number, id: PhisProductId) {
  const { rowCount } = await db.query(`SELECT 1 FROM phis.entitlements WHERE site_id = $1 AND product = $2 LIMIT 1`, [siteId, id]);
  return (rowCount ?? 0) > 0;
}

const sameTerms = (a: PhisProductReleasedTerms, b: PhisProductReleasedTerms) =>
  a.sale === b.sale && a.referralUrl === b.referralUrl && a.free === b.free
  && a.parts.length === b.parts.length && a.parts.every((part, index) => part === b.parts[index]);

export type RegisterOutcome = "created" | "updated" | "unchanged";

/**
 * Registers a supplier's product, or changes it. Idempotent on the key: the same draft twice changes
 * nothing, raises no version and owes no event.
 *
 * A new product is `draft`, or `active` where its manifest declared it (`declared`): the operator who
 * switched the Add-on on chose it, and it belongs to the Site. On a publisher's product that is already
 * released, changed `sale`, `referralUrl`, `free` or `parts` wait in `pending_terms`; before the first
 * release every field changes at once. A publisher is fixed: changing it would turn a released product
 * into the Site's own, which needs no release.
 */
export async function registerProduct(pool: Pool, input: {
  siteId: number;
  supplier: string;
  draft: PhisNormalizedProductDraft;
  declared?: boolean;
  listeners: readonly string[];
}): Promise<{ product: PhisStoredProduct; outcome: RegisterOutcome }> {
  const { siteId, supplier, draft } = input;
  const id = `${supplier}:${draft.key}` as PhisProductId;
  return withPoolTransaction(pool, async (client) => {
    if (draft.imageAssetId !== null) {
      const { rowCount } = await client.query(`SELECT 1 FROM phis.media_assets WHERE id = $1 AND site_id = $2`, [draft.imageAssetId, siteId]);
      if ((rowCount ?? 0) === 0) throw new PhisProductRuleError(`Asset ${draft.imageAssetId} is not an Asset of this Site.`);
    }
    let row = await selectRow(client, siteId, id, true);
    if (!row) {
      await assertParts(client, siteId, id, draft.parts);
      const flags = (draft.counted ? FLAG.Counted : 0) | (draft.free ? FLAG.Free : 0)
        | (draft.publisher === null ? FLAG.Released : 0) | (input.declared ? FLAG.Declared : 0);
      const inserted = await client.query(
        `INSERT INTO phis.products (site_id, supplier_addon_id, key, publisher, type, title, summary, image_asset_id,
           sale, referral_url, state, flags, parts)
         VALUES ($1::smallint, $2, $3, $4, $5, $6, $7, $8::int, $9, $10, $11, $12::int, $13::text[])
         ON CONFLICT (site_id, supplier_addon_id, key) DO NOTHING`,
        [siteId, supplier, draft.key, draft.publisher, draft.type, draft.title, draft.summary, draft.imageAssetId,
          draft.sale, draft.referralUrl, input.declared ? "active" : "draft", flags, draft.parts],
      );
      if ((inserted.rowCount ?? 0) > 0) {
        await enqueueProductChanged(client, { siteId, recipients: input.listeners, productId: id });
        return { product: (await readProduct(client, siteId, id))!, outcome: "created" as const };
      }
      row = (await selectRow(client, siteId, id, true))!;
    }

    if (row.publisher !== draft.publisher) {
      throw new PhisProductRuleError(`${id} has a publisher of its own that does not change; register another product instead.`);
    }
    const counted = (row.flags & FLAG.Counted) !== 0;
    if (counted !== draft.counted && await isNamedByEntitlement(client, siteId, id)) {
      throw new PhisProductRuleError(`${id} is named by an entitlement; whether it counts is fixed.`);
    }
    const current: PhisProductReleasedTerms = {
      sale: row.sale, referralUrl: row.referral_url, free: (row.flags & FLAG.Free) !== 0, parts: row.parts as PhisProductId[],
    };
    const asked: PhisProductReleasedTerms = { sale: draft.sale, referralUrl: draft.referralUrl, free: draft.free, parts: draft.parts };
    const holdsBack = row.publisher !== null && (row.flags & FLAG.Released) !== 0;
    const terms = holdsBack ? current : asked;
    const pending = holdsBack && !sameTerms(asked, current) ? asked : null;
    if (!sameTerms(asked, current)) await assertParts(client, siteId, id, draft.parts);

    const flags = (row.flags & ~(FLAG.Counted | FLAG.Free | FLAG.Declared))
      | (draft.counted ? FLAG.Counted : 0) | (terms.free ? FLAG.Free : 0)
      | ((row.flags & FLAG.Declared) !== 0 || input.declared ? FLAG.Declared : 0);
    const unchanged = row.type === draft.type && row.title === draft.title && row.summary === draft.summary
      && row.image_asset_id === draft.imageAssetId && flags === row.flags && sameTerms(terms, current)
      && (pending === null ? row.pending_terms === null : row.pending_terms !== null && sameTerms(pending, row.pending_terms));
    if (unchanged) return { product: (await readProduct(client, siteId, id))!, outcome: "unchanged" as const };

    await client.query(
      `UPDATE phis.products
       SET type = $2, title = $3, summary = $4, image_asset_id = $5::int, sale = $6, referral_url = $7,
           flags = $8::int, parts = $9::text[], pending_terms = $10::jsonb, version = version + 1, updated_at = NOW()
       WHERE id = $1`,
      [row.id, draft.type, draft.title, draft.summary, draft.imageAssetId, terms.sale, terms.referralUrl, flags,
        terms.parts, pending ? JSON.stringify(pending) : null],
    );
    await enqueueProductChanged(client, { siteId, recipients: input.listeners, productId: id });
    return { product: (await readProduct(client, siteId, id))!, outcome: "updated" as const };
  });
}

/** What moving a product changes, written once for the supplier, the operator and Core. */
async function writeState(
  client: PoolClient,
  input: { siteId: number; row: ProductRow; state: PhisProductState; listeners: readonly string[]; supplierOff?: boolean },
) {
  const flags = input.supplierOff ? input.row.flags | FLAG.SupplierOff : input.row.flags & ~FLAG.SupplierOff;
  await client.query(
    `UPDATE phis.products SET state = $2, flags = $3::int, version = version + 1, updated_at = NOW() WHERE id = $1`,
    [input.row.id, input.state, flags],
  );
  await enqueueProductChanged(client, {
    siteId: input.siteId, recipients: input.listeners, productId: `${input.row.supplier_addon_id}:${input.row.key}`,
  });
}

/**
 * Moves a supplier's own product between `draft`, `active` and `withdrawn`; null where it has none by
 * that key. `active` is refused for a publisher's product that is not released, and every move on a
 * locked product. Moving to the state it is in changes nothing.
 */
export async function setProductState(pool: Pool, input: {
  siteId: number;
  supplier: string;
  key: string;
  state: "draft" | "active" | "withdrawn";
  listeners: readonly string[];
}): Promise<PhisStoredProduct | null> {
  const id = `${input.supplier}:${input.key}` as PhisProductId;
  return withPoolTransaction(pool, async (client) => {
    const row = await selectRow(client, input.siteId, id, true);
    if (!row) return null;
    if (row.state === "locked") throw new PhisProductRuleError(`${id} is locked; only the Site operator moves it.`);
    if (input.state === "active" && row.publisher !== null && (row.flags & FLAG.Released) === 0) {
      throw new PhisProductRuleError(`${id} is a publisher's product that the Site operator has not released; it cannot be active yet.`);
    }
    if (row.state !== input.state) {
      await writeState(client, { siteId: input.siteId, row, state: input.state, listeners: input.listeners });
    }
    return readProduct(client, input.siteId, id);
  });
}

/**
 * Removes a supplier's own product that nobody ever acquired. False where an entitlement entry ever named
 * it, where it is a part of another product, or where the supplier has none by that key.
 */
export async function removeProduct(pool: Pool, input: { siteId: number; supplier: string; key: string }): Promise<boolean> {
  const id = `${input.supplier}:${input.key}` as PhisProductId;
  return withPoolTransaction(pool, async (client) => {
    const row = await selectRow(client, input.siteId, id, true);
    if (!row || await isNamedByEntitlement(client, input.siteId, id)) return false;
    const { rowCount: partOf } = await client.query(
      `SELECT 1 FROM phis.products WHERE site_id = $1 AND ($2 = ANY(parts) OR pending_terms->'parts' ? $2) LIMIT 1`,
      [input.siteId, id],
    );
    if ((partOf ?? 0) > 0) return false;
    await client.query(`DELETE FROM phis.products WHERE id = $1`, [row.id]);
    return true;
  });
}

/**
 * Writes one Add-on's own attributes of a product, whole; `null` takes them away. Null where the product
 * does not exist. A change raises the product's version and owes its event; writing what is already there
 * does neither.
 */
export async function annotateProduct(pool: Pool, input: {
  siteId: number;
  productId: PhisProductId;
  addonId: string;
  data: Record<string, unknown> | null;
  listeners: readonly string[];
}): Promise<PhisStoredProduct | null> {
  return withPoolTransaction(pool, async (client) => {
    const row = await selectRow(client, input.siteId, input.productId, true);
    if (!row) return null;
    const { rowCount } = input.data === null
      ? await client.query(`DELETE FROM phis.product_attributes WHERE product_id = $1 AND addon_id = $2`, [row.id, input.addonId])
      : await client.query(
        `INSERT INTO phis.product_attributes (product_id, addon_id, data) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (product_id, addon_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
         WHERE phis.product_attributes.data IS DISTINCT FROM EXCLUDED.data`,
        [row.id, input.addonId, JSON.stringify(input.data)],
      );
    if ((rowCount ?? 0) > 0) {
      await client.query(`UPDATE phis.products SET version = version + 1, updated_at = NOW() WHERE id = $1`, [row.id]);
      await enqueueProductChanged(client, { siteId: input.siteId, recipients: input.listeners, productId: input.productId });
    }
    return readProduct(client, input.siteId, input.productId);
  });
}

export type ReleaseOutcome = "released" | "applied" | "unchanged";

/**
 * The operator's release of a publisher's product: the first one, or the pending terms of a released
 * one. Null where there is no such product. The Site's own product needs none, which is refused rather
 * than answered as done.
 */
export async function releaseProduct(pool: Pool, input: {
  siteId: number;
  productId: PhisProductId;
  listeners: readonly string[];
}): Promise<{ product: PhisStoredProduct; outcome: ReleaseOutcome } | null> {
  return withPoolTransaction(pool, async (client) => {
    const row = await selectRow(client, input.siteId, input.productId, true);
    if (!row) return null;
    if (row.publisher === null) throw new PhisProductRuleError(`${input.productId} is the Site's own product and needs no release.`);
    const released = (row.flags & FLAG.Released) !== 0;
    const pending = row.pending_terms;
    if (released && !pending) return { product: (await readProduct(client, input.siteId, input.productId))!, outcome: "unchanged" as const };
    if (pending) await assertParts(client, input.siteId, input.productId, pending.parts);
    const terms: PhisProductReleasedTerms = pending ?? {
      sale: row.sale, referralUrl: row.referral_url, free: (row.flags & FLAG.Free) !== 0, parts: row.parts as PhisProductId[],
    };
    const flags = (row.flags | FLAG.Released) & ~FLAG.Free | (terms.free ? FLAG.Free : 0);
    await client.query(
      `UPDATE phis.products
       SET sale = $2, referral_url = $3, parts = $4::text[], flags = $5::int, pending_terms = NULL,
           version = version + 1, updated_at = NOW()
       WHERE id = $1`,
      [row.id, terms.sale, terms.referralUrl, terms.parts, flags],
    );
    await enqueueProductChanged(client, { siteId: input.siteId, recipients: input.listeners, productId: input.productId });
    return { product: (await readProduct(client, input.siteId, input.productId))!, outcome: released ? "applied" as const : "released" as const };
  });
}

export type OperatorMove = { id: PhisProductId; from: PhisProductState; to: PhisProductState };

/**
 * The operator's moves. `locked` takes any product that is not locked; `unlocked` takes a locked one to
 * `withdrawn` -- the state before the lock is not kept; `withdrawn` takes a draft or an active product
 * when it names one product, and the active ones when it names every product of a supplier or a
 * publisher. An explicit move ends the withdrawal that Core made because a supplier was switched off.
 */
export async function moveProductsAsOperator(pool: Pool, input: {
  siteId: number;
  to: "locked" | "unlocked" | "withdrawn";
  productId?: PhisProductId;
  supplier?: string;
  publisher?: string;
  listeners: readonly string[];
}): Promise<OperatorMove[]> {
  const target: PhisProductState = input.to === "unlocked" ? "withdrawn" : input.to;
  const from: PhisProductState[] = input.to === "locked" ? ["draft", "active", "withdrawn"]
    : input.to === "unlocked" ? ["locked"] : input.productId ? ["draft", "active"] : ["active"];
  const { supplier, key } = input.productId ? splitPhisProductId(input.productId) : { supplier: input.supplier ?? null, key: null };
  return withPoolTransaction(pool, async (client) => {
    const { rows } = await client.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM phis.products p
       WHERE p.site_id = $1 AND p.state = ANY($2::text[])
         AND ($3::text IS NULL OR p.supplier_addon_id = $3)
         AND ($4::text IS NULL OR p.key = $4)
         AND ($5::text IS NULL OR p.publisher = $5)
       ORDER BY p.id FOR UPDATE OF p`,
      [input.siteId, from, supplier, key, input.publisher ?? null],
    );
    const moves: OperatorMove[] = [];
    for (const row of rows) {
      await writeState(client, { siteId: input.siteId, row, state: target, listeners: input.listeners });
      moves.push({ id: `${row.supplier_addon_id}:${row.key}` as PhisProductId, from: row.state, to: target });
    }
    return moves;
  });
}

export type ProductSupplyChange = { siteId: number; id: PhisProductId; to: "withdrawn" | "active" };

/**
 * Brings the products in step with whether their supplier is switched on.
 *
 * An active product whose supplier is off goes to `withdrawn` with the `SupplierOff` bit; one that
 * carries the bit, is still `withdrawn` and whose supplier is on again goes back to `active`. A product
 * the supplier left in draft, or the operator moved, is not touched. Products and entries stay. It reads
 * the same predicate as `supplied`, and is safe to run twice. Answers what it changed, so the caller can
 * ask for delivery on those Sites.
 */
export async function reconcileProductSupply(pool: Pool, listeners: readonly string[], siteId?: number): Promise<ProductSupplyChange[]> {
  return withPoolTransaction(pool, async (client) => {
    const changes: ProductSupplyChange[] = [];
    const scope = siteId === undefined ? "" : "AND p.site_id = $1::smallint";
    const params = siteId === undefined ? [] : [siteId];
    const lost = await client.query<{ site_id: number; supplier_addon_id: string; key: string }>(
      `UPDATE phis.products p
       SET state = 'withdrawn', flags = p.flags | ${FLAG.SupplierOff}, version = p.version + 1, updated_at = NOW()
       WHERE p.state = 'active' AND NOT ${suppliedSql("p")} ${scope}
       RETURNING p.site_id, p.supplier_addon_id, p.key`,
      params,
    );
    const back = await client.query<{ site_id: number; supplier_addon_id: string; key: string }>(
      `UPDATE phis.products p
       SET state = 'active', flags = p.flags & ~${FLAG.SupplierOff}, version = p.version + 1, updated_at = NOW()
       WHERE p.state = 'withdrawn' AND (p.flags & ${FLAG.SupplierOff}) <> 0 AND ${suppliedSql("p")} ${scope}
       RETURNING p.site_id, p.supplier_addon_id, p.key`,
      params,
    );
    for (const [rows, to] of [[lost.rows, "withdrawn"], [back.rows, "active"]] as const) {
      for (const row of rows) {
        const id = `${row.supplier_addon_id}:${row.key}` as PhisProductId;
        await enqueueProductChanged(client, { siteId: row.site_id, recipients: listeners, productId: id });
        changes.push({ siteId: row.site_id, id, to });
      }
    }
    return changes;
  });
}

export type ManifestProductAction = { key: string; action: RegisterOutcome | "withdrawn" | "refused"; message?: string };

/**
 * Registers the products a supplier's manifest declares at one Site, and withdraws those it declared
 * before and no longer does.
 *
 * Run when the Add-on is switched on for the Site and when a release is reconciled, so it is safe to run
 * twice. A declared product that is new starts `active`; an existing one has its details compared and its
 * state left alone. A product that came from a manifest and is not declared now is withdrawn, never
 * removed -- also one Core withdrew for its supplier, which then stays withdrawn when the supplier is back. A product that breaks a rule is reported and does not stop the others; products that are
 * parts of others are registered first.
 */
export async function syncManifestProducts(pool: Pool, input: {
  siteId: number;
  supplier: string;
  declared: readonly PhisNormalizedProductDraft[];
  listeners: readonly string[];
}): Promise<ManifestProductAction[]> {
  const actions: ManifestProductAction[] = [];
  const ordered: PhisNormalizedProductDraft[] = [];
  const pending = [...input.declared];
  while (pending.length > 0) {
    const index = pending.findIndex((draft) => draft.parts.every((part) =>
      !pending.some((other) => `${input.supplier}:${other.key}` === part && other !== draft)));
    ordered.push(...pending.splice(index === -1 ? 0 : index, 1));
  }
  for (const draft of ordered) {
    try {
      const { outcome } = await registerProduct(pool, { siteId: input.siteId, supplier: input.supplier, draft, declared: true, listeners: input.listeners });
      actions.push({ key: draft.key, action: outcome });
    } catch (error) {
      if (!(error instanceof PhisProductRuleError)) throw error;
      actions.push({ key: draft.key, action: "refused", message: error.message });
    }
  }
  const dropped = await withPoolTransaction(pool, async (client) => {
    const { rows } = await client.query<{ key: string }>(
      `UPDATE phis.products p
       SET state = 'withdrawn', flags = p.flags & ~${FLAG.SupplierOff}, version = p.version + 1, updated_at = NOW()
       WHERE p.site_id = $1 AND p.supplier_addon_id = $2 AND (p.flags & ${FLAG.Declared}) <> 0
         AND (p.state IN ('draft', 'active') OR (p.state = 'withdrawn' AND (p.flags & ${FLAG.SupplierOff}) <> 0))
         AND NOT (p.key = ANY($3::text[]))
       RETURNING p.key`,
      [input.siteId, input.supplier, input.declared.map((draft) => draft.key)],
    );
    for (const row of rows) {
      await enqueueProductChanged(client, { siteId: input.siteId, recipients: input.listeners, productId: `${input.supplier}:${row.key}` });
    }
    return rows;
  });
  for (const row of dropped) actions.push({ key: row.key, action: "withdrawn" });
  return actions;
}
