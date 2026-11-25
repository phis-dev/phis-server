import type { Pool, PoolClient } from "pg";

import type {
  PhisProduct,
  PhisProductId,
  PhisProductListInput,
  PhisProductReleasedTerms,
  PhisProductSale,
  PhisProductState,
} from "@phis/contracts/products";

import { PhiMediaDeliveryPolicy, PhiMediaLifecycleStatus } from "@phis/contracts/media";
import type { PhisProductLink } from "@phis/contracts/products";
import type { PhiLinkTarget } from "@phis/contracts/references";

import { PHIS_PRODUCT_FLAG } from "../lib/constants/products.ts";
import { PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED, PHIS_ADDON_FLAG_GLOBALLY_ENABLED } from "../lib/constants/server-addons.ts";
import { PhisMediaSpaceKind } from "../lib/constants/media-space-kinds.ts";
import { withPoolTransaction } from "../lib/db-transaction.ts";
import { splitPhisProductId, type PhisNormalizedProductDraft } from "../lib/addons/product-draft.ts";
import { computePhiMessageHash, ensurePhiSiteMessageId } from "./translation-message.mts";
import { buildTranslationContext } from "../lib/translation-context.ts";

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
 * A product as the database holds it. `imagePath`, `iconPath` and their list variants are not here: Core's
 * address of a Media Asset is built where the Media delivery lives (`resolvePhiMediaDeliveryUrl`,
 * `resolvePhiMediaVariantUrl`), from the Asset's parts joined into every read, and never stored.
 */
export type PhisStoredProduct = Omit<PhisProduct, "imagePath" | "iconPath" | "imageListPath" | "iconListPath" | "gallery" | "sourceLocale" | "translated"> & {
  /** Core's number for the product (`phis.products.id`), which its texts' contexts name; never handed to an Add-on. */
  readonly rowId: number;
  /** The language the texts are written in, as kept: null for the Site's, which only the capability knows. */
  readonly sourceLocale: string | null;
  readonly imageMedia: PhisProductMedia | null;
  readonly iconMedia: PhisProductMedia | null;
  /** The gallery, first to last: each picture's parts, as `imageMedia` for the picture (`phis.product_gallery`). */
  readonly galleryMedia: readonly PhisProductMedia[];
  /**
   * The words' messages in the Site's translation store with what is held for the locale read, per field that
   * has a text (`phis.product_texts`); only on a read that named a locale, empty otherwise.
   */
  readonly textMessages: Readonly<Partial<Record<PhisProductTextField, PhisProductTextMessage>>>;
};

/**
 * The fields of a product that are words, each a source text of the Site's translation store. `link_label`
 * is the label of the product's button (`phis.product_links`).
 */
export const PHIS_PRODUCT_TEXT_FIELDS = ["title", "summary", "description", "link_label"] as const;
export type PhisProductTextField = (typeof PHIS_PRODUCT_TEXT_FIELDS)[number];

/** A field's message, and its translation into the locale read; null where none is held. */
export type PhisProductTextMessage = { readonly msgId: number; readonly translation: string | null };

/**
 * The context a product's field is kept under in its Site's translation store: `product <id> <field>`.
 *
 * Per product rather than one phrase for every product's title, because the context is half of a message's
 * identity and the hash covers a message's first 50 characters: two products whose summaries open alike --
 * a Free and a Pro edition -- would be one key, and the second could not be recorded at all. Per product
 * they never meet, and a product's old text can go when it changes without asking who else uses it. What
 * a provider is told is the field alone (`PHIS_PRODUCT_TEXT_PROVIDER_CONTEXTS`); the number stays in the
 * store, where Editor > Translations shows it and a translator can search for it.
 */
export function phisProductTextContext(productId: number, field: PhisProductTextField) {
  // The link's label is `product <n> link label`, as `@phis/contracts/products` names it.
  return `product ${productId} ${field === "link_label" ? "link label" : field}`;
}

/**
 * Where the TR route's external path keeps a product's field written in another language than the Site's
 * (TRANSLATIONS.md, "External and non-canonical sources"): the field's own context with the `[extern]` flag.
 * The unit's message is the Site-language rendering, its original the protected variant. Per product, as
 * the field's message is, so a changed text or language takes the old unit along and nothing else meets it.
 */
export function phisProductExternalTextContext(productId: number, field: PhisProductTextField) {
  return buildTranslationContext({ context: phisProductTextContext(productId, field), flags: ["extern"] });
}

const externalTextContexts = (productId: number, fields: readonly PhisProductTextField[]) =>
  fields.map((field) => phisProductExternalTextContext(productId, field));

/**
 * The parts of a product's picture or icon its addresses are built from -- the delivery's
 * (`resolvePhiMediaDeliveryUrl`) and one of its image variants' (`resolvePhiMediaVariantUrl`) -- `null` where
 * the product names none or the Asset is gone.
 */
export type PhisProductMedia = {
  readonly id: number;
  readonly deliveryRevision: number;
  readonly variantVersion: number | null;
  readonly contentType: string;
};

/** A rule the product directory enforces; the message says which, for the Add-on or the operator. */
export class PhisProductRuleError extends Error {}

const FLAG = PHIS_PRODUCT_FLAG;

/*
 * The picture and the icon are joined into every read, not read per row: a list shows them on every line,
 * and an address of a variant needs the Asset's content type and variant version beside the revision.
 */
const PRODUCT_COLUMNS = `p.id, p.supplier_addon_id, p.key, p.publisher, p.type, p.title, p.summary, p.description, p.source_locale, p.image_asset_id,
  p.icon_asset_id, p.sale, p.referral_url, p.state, p.flags, p.parts, p.pending_terms, p.version, p.created_at, p.updated_at,
  ${suppliedSql("p")} AS supplied,
  image.delivery_revision AS image_media_revision, image.variant_version AS image_media_variant_version,
  image.content_type AS image_media_content_type,
  icon.delivery_revision AS icon_media_revision, icon.variant_version AS icon_media_variant_version,
  icon.content_type AS icon_media_content_type,
  pl.target AS link_target, pl.label AS link_label`;
const PRODUCT_FROM = `FROM phis.products p
  LEFT JOIN phis.product_links pl ON pl.product_id = p.id
  LEFT JOIN phis.media_assets image ON image.id = p.image_asset_id AND image.site_id = p.site_id
  LEFT JOIN phis.media_assets icon ON icon.id = p.icon_asset_id AND icon.site_id = p.site_id`;

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
  description: string;
  source_locale: string | null;
  image_asset_id: number | null;
  icon_asset_id: number | null;
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
  link_target: PhiLinkTarget | null;
  link_label: string | null;
} & {
  [Column in `${"image" | "icon"}_media_${"revision" | "variant_version"}`]: number | null;
} & {
  image_media_content_type: string | null;
  icon_media_content_type: string | null;
};

function productMedia(row: ProductRow, which: "image" | "icon"): PhisProductMedia | null {
  const id = row[`${which}_asset_id`];
  const revision = row[`${which}_media_revision`];
  const contentType = row[`${which}_media_content_type`];
  if (id === null || revision === null || contentType === null) return null;
  return { id, deliveryRevision: revision, variantVersion: row[`${which}_media_variant_version`], contentType };
}

function mapProduct(
  row: ProductRow,
  attributes: Record<string, Record<string, unknown>>,
  galleryMedia: readonly PhisProductMedia[],
  textMessages: Partial<Record<PhisProductTextField, PhisProductTextMessage>>,
): PhisStoredProduct {
  return {
    id: `${row.supplier_addon_id}:${row.key}` as PhisProductId,
    rowId: row.id,
    supplier: row.supplier_addon_id,
    supplied: row.supplied,
    publisher: row.publisher,
    type: row.type,
    title: row.title,
    summary: row.summary,
    description: row.description,
    link: row.link_target ? { target: row.link_target, label: row.link_label ?? "" } : null,
    sourceLocale: row.source_locale,
    imageAssetId: row.image_asset_id,
    imageMedia: productMedia(row, "image"),
    iconAssetId: row.icon_asset_id,
    iconMedia: productMedia(row, "icon"),
    galleryMedia,
    textMessages,
    counted: (row.flags & FLAG.Counted) !== 0,
    sale: row.sale,
    referralUrl: row.referral_url,
    free: (row.flags & FLAG.Free) !== 0,
    accountRequired: (row.flags & FLAG.AccountRequired) !== 0,
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

/** The galleries of the products named, one query for all of them, each first to last. */
async function loadGalleries(db: DbQueryable, ids: readonly number[]) {
  const byProduct = new Map<number, PhisProductMedia[]>();
  if (ids.length === 0) return byProduct;
  const { rows } = await db.query<{
    product_id: number; asset_id: number; delivery_revision: number; variant_version: number | null; content_type: string;
  }>(
    `SELECT g.product_id, g.asset_id, a.delivery_revision, a.variant_version, a.content_type
     FROM phis.product_gallery g
     JOIN phis.media_assets a ON a.id = g.asset_id AND a.site_id = g.site_id
     WHERE g.product_id = ANY($1::int[])
     ORDER BY g.product_id, g.position`,
    [ids],
  );
  for (const row of rows) {
    const entry = byProduct.get(row.product_id) ?? [];
    entry.push({ id: row.asset_id, deliveryRevision: row.delivery_revision, variantVersion: row.variant_version, contentType: row.content_type });
    byProduct.set(row.product_id, entry);
  }
  return byProduct;
}

/**
 * The words' messages of the products named and what is held for `locale`, one query for all of them; a
 * field without a text has no message and is not here.
 */
async function loadTextMessages(db: DbQueryable, ids: readonly number[], locale: string) {
  const byProduct = new Map<number, Partial<Record<PhisProductTextField, PhisProductTextMessage>>>();
  if (ids.length === 0) return byProduct;
  const { rows } = await db.query<{ product_id: number; field: PhisProductTextField; msg_id: number; translation: string | null }>(
    `SELECT t.product_id, t.field, t.msg_id, l.translation
     FROM phis.product_texts t
     LEFT JOIN phis.tr_site_lang l ON l.msg_id = t.msg_id AND l.locale = $2
     WHERE t.product_id = ANY($1::int[])`,
    [ids, locale],
  );
  for (const row of rows) {
    const entry = byProduct.get(row.product_id) ?? {};
    entry[row.field] = { msgId: row.msg_id, translation: row.translation?.trim() ? row.translation : null };
    byProduct.set(row.product_id, entry);
  }
  return byProduct;
}

/** `locale`: also the words' messages and what is held for that language (`textMessages`); null: neither. */
async function mapProducts(db: DbQueryable, rows: readonly ProductRow[], locale: string | null = null) {
  const ids = rows.map((row) => row.id);
  const [attributes, galleries, texts] = await Promise.all([
    loadAttributes(db, ids),
    loadGalleries(db, ids),
    locale === null ? new Map<number, Partial<Record<PhisProductTextField, PhisProductTextMessage>>>() : loadTextMessages(db, ids, locale),
  ]);
  return rows.map((row) => mapProduct(row, attributes.get(row.id) ?? {}, galleries.get(row.id) ?? [], texts.get(row.id) ?? {}));
}

/**
 * Records a product's words as source texts of its Site's translation store (`phis.product_texts`), in the
 * caller's transaction: a field whose text is unchanged keeps its message, a changed one gets a new message
 * and its old one is deleted -- its translations with it, which were of the old words -- and a field emptied
 * loses its message. Safe to run again; what is recorded already costs one read.
 *
 * Before a new message is made, one of the same context and opening that no field names any more is
 * deleted: the hash covers the first 50 characters, so a description changed further on would otherwise meet
 * the message of its old wording (`phis translations import --add` can leave one) and be refused.
 */
async function recordProductTexts(db: DbQueryable, input: {
  siteId: number;
  productId: number;
  texts: Readonly<Record<PhisProductTextField, string>>;
  /** The texts' language changed: every field is a new text, and what was translated from the old reading goes. */
  languageChanged?: boolean;
}) {
  const { rows } = await db.query<{ field: PhisProductTextField; msg_id: number; msg: string }>(
    `SELECT t.field, t.msg_id, m.msg
     FROM phis.product_texts t JOIN phis.tr_site_msg m ON m.id = t.msg_id
     WHERE t.product_id = $1`,
    [input.productId],
  );
  const recorded = new Map(rows.map((row) => [row.field, row]));
  const changed = PHIS_PRODUCT_TEXT_FIELDS.filter((field) => (input.languageChanged || recorded.get(field)?.msg !== input.texts[field])
    && (recorded.has(field) || input.texts[field] !== ""));
  if (changed.length === 0) return;
  // A changed field's rendering through the external path, if it was written in another language, goes too.
  await db.query(`DELETE FROM phis.tr_site_msg WHERE site_id = $1 AND ctx = ANY($2::text[])`, [input.siteId, externalTextContexts(input.productId, changed)]);
  const gone = changed.flatMap((field) => {
    const row = recorded.get(field);
    return row ? [row.msg_id] : [];
  });
  // The link rows go with their messages (ON DELETE CASCADE).
  if (gone.length > 0) await db.query(`DELETE FROM phis.tr_site_msg WHERE id = ANY($1::int[])`, [gone]);
  for (const field of changed) {
    const text = input.texts[field];
    if (text === "") continue;
    const ctx = phisProductTextContext(input.productId, field);
    await db.query(
      `DELETE FROM phis.tr_site_msg WHERE site_id = $1 AND msg_hash = decode($2, 'hex') AND ctx = $3 AND msg <> $4`,
      [input.siteId, computePhiMessageHash(text), ctx, text],
    );
    const msgId = await ensurePhiSiteMessageId(db, input.siteId, text, ctx);
    await db.query(
      `INSERT INTO phis.product_texts (product_id, field, msg_id) VALUES ($1, $2, $3)
       ON CONFLICT (product_id, field) DO UPDATE SET msg_id = EXCLUDED.msg_id`,
      [input.productId, field, msgId],
    );
  }
}

/** The texts as the store keeps them: trimmed, as the TR route reads a message (`translateSiteBatchWithCache`). */
const draftTexts = (draft: PhisNormalizedProductDraft) => ({
  title: draft.title.trim(),
  summary: draft.summary.trim(),
  description: draft.description.trim(),
  link_label: draft.link?.label ?? "",
});

/** A value with its keys sorted, so two link targets compare by content and not by the order jsonb keeps. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sameLink = (row: ProductRow, link: PhisProductLink | null) => link === null
  ? row.link_target === null
  : row.link_target !== null && (row.link_label ?? "") === link.label && canonicalJson(row.link_target) === canonicalJson(link.target);

/** Writes the product's button whole, or removes it (`phis.product_links`). */
async function writeLink(db: DbQueryable, productId: number, link: PhisProductLink | null) {
  if (link === null) {
    await db.query(`DELETE FROM phis.product_links WHERE product_id = $1`, [productId]);
    return;
  }
  await db.query(
    `INSERT INTO phis.product_links (product_id, target, label) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (product_id) DO UPDATE SET target = EXCLUDED.target, label = EXCLUDED.label`,
    [productId, JSON.stringify(link.target), link.label],
  );
}

/** The gallery's Asset ids as stored, first to last, under the caller's lock on the product's row. */
async function readGalleryIds(db: DbQueryable, productId: number) {
  const { rows } = await db.query<{ asset_id: number }>(
    `SELECT asset_id FROM phis.product_gallery WHERE product_id = $1 ORDER BY position`,
    [productId],
  );
  return rows.map((row) => row.asset_id);
}

/** Writes the gallery whole, first to last; positions start at 0 again. */
async function writeGallery(db: DbQueryable, input: { productId: number; siteId: number; gallery: readonly number[] }) {
  await db.query(`DELETE FROM phis.product_gallery WHERE product_id = $1`, [input.productId]);
  if (input.gallery.length === 0) return;
  await db.query(
    `INSERT INTO phis.product_gallery (product_id, site_id, position, asset_id)
     SELECT $1::int, $2::smallint, (entry.ordinality - 1)::smallint, entry.asset_id
     FROM unnest($3::int[]) WITH ORDINALITY AS entry(asset_id, ordinality)`,
    [input.productId, input.siteId, input.gallery],
  );
}

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((id, index) => id === b[index]);

async function selectRow(db: DbQueryable, siteId: number, id: PhisProductId, lock = false) {
  const { supplier, key } = splitPhisProductId(id);
  const { rows } = await db.query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM}
     WHERE p.site_id = $1 AND p.supplier_addon_id = $2 AND p.key = $3${lock ? " FOR UPDATE OF p" : ""}`,
    [siteId, supplier, key],
  );
  return rows[0] ?? null;
}

/** `locale`: with the words' messages and what is held for that language (`textMessages`). */
export async function readProduct(
  db: DbQueryable,
  siteId: number,
  id: PhisProductId,
  locale: string | null = null,
): Promise<PhisStoredProduct | null> {
  const row = await selectRow(db, siteId, id);
  return row ? (await mapProducts(db, [row], locale))[0]! : null;
}

/**
 * Whether a product waits for the operator's release: a publisher's product never released, or a
 * released one with pending terms. One predicate for `released: false` of `products:v1` and the
 * directory's `awaitingRelease`, so the release list and the directory cannot disagree.
 */
const AWAITING_RELEASE_SQL = (alias: string) =>
  `((${alias}.publisher IS NOT NULL AND (${alias}.flags & ${FLAG.Released}) = 0) OR ${alias}.pending_terms IS NOT NULL)`;

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
  /** As `readProduct`'s. */
  locale?: string | null;
}): Promise<{ products: PhisStoredProduct[]; nextCursor: string | null }> {
  const afterId = decodeCursor(input.cursor);
  const { rows } = await db.query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM}
     WHERE p.site_id = $1
       AND p.state = ANY($2::text[])
       AND ($3::text IS NULL OR p.supplier_addon_id = $3)
       AND ($4::text IS NULL OR p.publisher = $4)
       AND ($5::text IS NULL OR p.type = $5)
       AND ($6::boolean IS NULL
         OR ($6 AND (p.publisher IS NULL OR (p.flags & ${FLAG.Released}) <> 0))
         OR (NOT $6 AND ${AWAITING_RELEASE_SQL("p")}))
       AND ($9::text[] IS NULL OR p.supplier_addon_id || ':' || p.key = ANY($9::text[]))
       AND p.id > $7::int
     ORDER BY p.id ASC
     LIMIT $8::int`,
    [input.siteId, input.states, input.supplier ?? null, input.publisher ?? null, input.type ?? null,
      input.released ?? null, afterId, input.limit + 1, input.ids ?? null],
  );
  const page = rows.slice(0, input.limit);
  const products = await mapProducts(db, page, input.locale ?? null);
  return { products, nextCursor: rows.length > input.limit ? encodeCursor(page[page.length - 1]!.id) : null };
}

/** `%` and `_` are a LIKE's own; a search names them literally. */
function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * One page of the Site's product directory as its operator administers it (`GET /api/site/products`):
 * every state unless `states` narrows it, by supplier, by whether it waits for a release, and by a
 * search in the title and the id, ordered by supplier and key and counted, because the operator's
 * Table pages by number. `listProducts` is the capability's reading, by cursor; this one is the
 * operator's.
 */
export async function listProductDirectory(db: DbQueryable, input: {
  siteId: number;
  states: readonly PhisProductState[];
  supplier?: string;
  /** True: only those waiting for a release; false: only those that are not; absent: both. */
  awaitingRelease?: boolean;
  /** A part of the title or of the id, any case. */
  search?: string;
  page: number;
  pageSize: number;
}): Promise<{ products: PhisStoredProduct[]; total: number }> {
  const search = input.search ? `%${escapeLike(input.search.toLowerCase())}%` : null;
  const where = `p.site_id = $1
       AND p.state = ANY($2::text[])
       AND ($3::text IS NULL OR p.supplier_addon_id = $3)
       AND ($4::boolean IS NULL OR ${AWAITING_RELEASE_SQL("p")} = $4)
       AND ($5::text IS NULL
         OR lower(p.title) LIKE $5 ESCAPE '\\'
         OR lower(p.supplier_addon_id || ':' || p.key) LIKE $5 ESCAPE '\\')`;
  const filter = [input.siteId, input.states, input.supplier ?? null, input.awaitingRelease ?? null, search];
  const { rows } = await db.query<ProductRow & { total: string }>(
    `SELECT ${PRODUCT_COLUMNS}, COUNT(*) OVER () AS total
     ${PRODUCT_FROM}
     WHERE ${where}
     ORDER BY p.supplier_addon_id ASC, p.key ASC
     LIMIT $6::int OFFSET $7::int`,
    [...filter, input.pageSize, (input.page - 1) * input.pageSize],
  );
  // Past the last page the window has no row to carry the count, so it is asked for on its own.
  const total = rows.length > 0 ? Number(rows[0]!.total) : input.page > 1
    ? Number((await db.query<{ total: string }>(`SELECT COUNT(*) AS total FROM phis.products p WHERE ${where}`, filter)).rows[0]!.total)
    : 0;
  return { products: await mapProducts(db, rows), total };
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
  && a.accountRequired === b.accountRequired
  && a.parts.length === b.parts.length && a.parts.every((part, index) => part === b.parts[index]);

/**
 * The ids of the Site's products that wear the Asset as their picture, their icon or a picture of their
 * gallery; the Media delete guard names them, and `media-release:v1` keeps an Asset they name.
 */
export async function listProductIdsWithImage(db: DbQueryable, siteId: number, assetId: number): Promise<PhisProductId[]> {
  const { rows } = await db.query<{ supplier_addon_id: string; key: string }>(
    `SELECT p.supplier_addon_id, p.key FROM phis.products p
     WHERE p.site_id = $1
       AND (p.image_asset_id = $2 OR p.icon_asset_id = $2
         OR EXISTS (SELECT 1 FROM phis.product_gallery g WHERE g.product_id = p.id AND g.site_id = $1 AND g.asset_id = $2))
     ORDER BY p.supplier_addon_id, p.key`,
    [siteId, assetId],
  );
  return rows.map((row) => `${row.supplier_addon_id}:${row.key}` as PhisProductId);
}

/**
 * Whether a visitor would be served the Asset as a product's picture or icon: it is ready, delivered
 * publicly, and lies in the Site's Space or in the registering supplier's own Add-on Space (its slot
 * files, the shop's cover, say). An Asset of a User or Group Space, or of another Add-on's Space, is
 * refused. An Asset of another Site, or none, gets the same answer as before, so the message tells
 * nothing about what exists elsewhere.
 */
async function assertProductImage(db: DbQueryable, siteId: number, supplier: string, assetId: number, use: "picture" | "icon" | "gallery picture") {
  const { rows } = await db.query<{ lifecycle_status: number; delivery_policy: number; kind: number; addon_id: string | null }>(
    `SELECT a.lifecycle_status, a.delivery_policy, s.kind, s.addon_id
     FROM phis.media_assets a JOIN phis.media_spaces s ON s.id = a.space_id AND s.site_id = a.site_id
     WHERE a.id = $1 AND a.site_id = $2`,
    [assetId, siteId],
  );
  const asset = rows[0];
  if (!asset) throw new PhisProductRuleError(`Asset ${assetId} is not an Asset of this Site.`);
  const inReach = asset.kind === PhisMediaSpaceKind.Site || (asset.kind === PhisMediaSpaceKind.Addon && asset.addon_id === supplier);
  if (asset.lifecycle_status !== PhiMediaLifecycleStatus.Ready || asset.delivery_policy !== PhiMediaDeliveryPolicy.Public || !inReach) {
    throw new PhisProductRuleError(
      `Asset ${assetId} cannot be a product's ${use}: a visitor is served only an Asset that is ready, delivered publicly, and in the Site's Space or the supplier's own Add-on Space.`,
    );
  }
}

export type RegisterOutcome = "created" | "updated" | "unchanged";

/**
 * Registers a supplier's product, or changes it. Idempotent on the key: the same draft twice changes
 * nothing, raises no version and owes no event.
 *
 * The gallery is checked as the picture is, each Asset of it, and compared in its order: another picture or
 * another order is a change, which raises the version and owes `product.changed` like any other.
 *
 * A new product is `draft`, or `active` where its manifest declared it (`declared`): the operator who
 * switched the Add-on on chose it, and it belongs to the Site. On a publisher's product that is already
 * released, changed `sale`, `referralUrl`, `free`, `accountRequired` or `parts` wait in `pending_terms`; before the first
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
    // A manifest does not speak of the picture, the icon or the gallery, so a manifest sync neither sets nor clears them.
    if (!input.declared && draft.imageAssetId !== null) await assertProductImage(client, siteId, supplier, draft.imageAssetId, "picture");
    if (!input.declared && draft.iconAssetId !== null) await assertProductImage(client, siteId, supplier, draft.iconAssetId, "icon");
    if (!input.declared) {
      for (const assetId of draft.gallery) await assertProductImage(client, siteId, supplier, assetId, "gallery picture");
    }
    let row = await selectRow(client, siteId, id, true);
    const pickImage = (current: number | null) => (input.declared ? current : draft.imageAssetId);
    const pickIcon = (current: number | null) => (input.declared ? current : draft.iconAssetId);
    const pickGallery = (current: readonly number[]) => (input.declared ? current : draft.gallery);
    if (!row) {
      await assertParts(client, siteId, id, draft.parts);
      const flags = (draft.counted ? FLAG.Counted : 0) | (draft.free ? FLAG.Free : 0) | (draft.accountRequired ? FLAG.AccountRequired : 0)
        | (draft.publisher === null ? FLAG.Released : 0) | (input.declared ? FLAG.Declared : 0);
      const inserted = await client.query(
        `INSERT INTO phis.products (site_id, supplier_addon_id, key, publisher, type, title, summary, description, source_locale,
           image_asset_id, icon_asset_id, sale, referral_url, state, flags, parts)
         VALUES ($1::smallint, $2, $3, $4, $5, $6, $7, $15, $16, $8::int, $9::int, $10, $11, $12, $13::int, $14::text[])
         ON CONFLICT (site_id, supplier_addon_id, key) DO NOTHING
         RETURNING id`,
        [siteId, supplier, draft.key, draft.publisher, draft.type, draft.title, draft.summary, pickImage(null), pickIcon(null),
          draft.sale, draft.referralUrl, input.declared ? "active" : "draft", flags, draft.parts, draft.description, draft.sourceLocale],
      );
      if ((inserted.rowCount ?? 0) > 0) {
        const productId = (inserted.rows[0] as { id: number }).id;
        await writeGallery(client, { productId, siteId, gallery: pickGallery([]) });
        if (draft.link) await writeLink(client, productId, draft.link);
        await recordProductTexts(client, { siteId, productId, texts: draftTexts(draft) });
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
      sale: row.sale, referralUrl: row.referral_url, free: (row.flags & FLAG.Free) !== 0,
      accountRequired: (row.flags & FLAG.AccountRequired) !== 0, parts: row.parts as PhisProductId[],
    };
    const asked: PhisProductReleasedTerms = { sale: draft.sale, referralUrl: draft.referralUrl, free: draft.free, accountRequired: draft.accountRequired, parts: draft.parts };
    const holdsBack = row.publisher !== null && (row.flags & FLAG.Released) !== 0;
    const terms = holdsBack ? current : asked;
    const pending = holdsBack && !sameTerms(asked, current) ? asked : null;
    if (!sameTerms(asked, current)) await assertParts(client, siteId, id, draft.parts);

    const flags = (row.flags & ~(FLAG.Counted | FLAG.Free | FLAG.AccountRequired | FLAG.Declared))
      | (draft.counted ? FLAG.Counted : 0) | (terms.free ? FLAG.Free : 0) | (terms.accountRequired ? FLAG.AccountRequired : 0)
      | ((row.flags & FLAG.Declared) !== 0 || input.declared ? FLAG.Declared : 0);
    const storedGallery = await readGalleryIds(client, row.id);
    const gallery = pickGallery(storedGallery);
    const languageChanged = row.source_locale !== draft.sourceLocale;
    const unchanged = row.type === draft.type && row.title === draft.title && row.summary === draft.summary
      && row.description === draft.description && sameLink(row, draft.link) && !languageChanged && sameIds(storedGallery, gallery)
      && row.image_asset_id === pickImage(row.image_asset_id) && row.icon_asset_id === pickIcon(row.icon_asset_id)
      && flags === row.flags && sameTerms(terms, current)
      && (pending === null ? row.pending_terms === null : row.pending_terms !== null && sameTerms(pending, row.pending_terms));
    // Unchanged still records: a product registered before its words were source texts has none yet.
    await recordProductTexts(client, { siteId, productId: row.id, texts: draftTexts(draft), languageChanged });
    if (unchanged) return { product: (await readProduct(client, siteId, id))!, outcome: "unchanged" as const };

    await client.query(
      `UPDATE phis.products
       SET type = $2, title = $3, summary = $4, image_asset_id = $5::int, icon_asset_id = $6::int, sale = $7,
           referral_url = $8, flags = $9::int, parts = $10::text[], pending_terms = $11::jsonb, description = $12,
           source_locale = $13, version = version + 1, updated_at = NOW()
       WHERE id = $1`,
      [row.id, draft.type, draft.title, draft.summary, pickImage(row.image_asset_id), pickIcon(row.icon_asset_id), terms.sale,
        terms.referralUrl, flags, terms.parts, pending ? JSON.stringify(pending) : null, draft.description, draft.sourceLocale],
    );
    if (!sameIds(storedGallery, gallery)) await writeGallery(client, { productId: row.id, siteId, gallery });
    if (!sameLink(row, draft.link)) await writeLink(client, row.id, draft.link);
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
    // Its words go with it: their context is this product's, so nothing else names those messages.
    await client.query(`DELETE FROM phis.tr_site_msg WHERE id IN (SELECT msg_id FROM phis.product_texts WHERE product_id = $1)`, [row.id]);
    // And their renderings through the external path, for a product written in another language than the Site's.
    await client.query(`DELETE FROM phis.tr_site_msg WHERE site_id = $1 AND ctx = ANY($2::text[])`,
      [input.siteId, externalTextContexts(row.id, PHIS_PRODUCT_TEXT_FIELDS)]);
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
 *
 * `expectedVersion` is the version whose terms the operator read; a product that has moved on since is
 * refused, judged under the lock on its row, so terms nobody compared are never released.
 */
export async function releaseProduct(pool: Pool, input: {
  siteId: number;
  productId: PhisProductId;
  listeners: readonly string[];
  expectedVersion?: number;
}): Promise<{ product: PhisStoredProduct; outcome: ReleaseOutcome } | null> {
  return withPoolTransaction(pool, async (client) => {
    const row = await selectRow(client, input.siteId, input.productId, true);
    if (!row) return null;
    if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
      throw new PhisProductRuleError(
        `${input.productId} is at version ${row.version}, not ${input.expectedVersion}: it changed since it was read; read it again before releasing.`,
      );
    }
    if (row.publisher === null) throw new PhisProductRuleError(`${input.productId} is the Site's own product and needs no release.`);
    const released = (row.flags & FLAG.Released) !== 0;
    const pending = row.pending_terms;
    if (released && !pending) return { product: (await readProduct(client, input.siteId, input.productId))!, outcome: "unchanged" as const };
    if (pending) await assertParts(client, input.siteId, input.productId, pending.parts);
    const terms: PhisProductReleasedTerms = pending ?? {
      sale: row.sale, referralUrl: row.referral_url, free: (row.flags & FLAG.Free) !== 0,
      accountRequired: (row.flags & FLAG.AccountRequired) !== 0, parts: row.parts as PhisProductId[],
    };
    const flags = ((row.flags | FLAG.Released) & ~(FLAG.Free | FLAG.AccountRequired))
      | (terms.free ? FLAG.Free : 0) | (terms.accountRequired ? FLAG.AccountRequired : 0);
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
      `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM}
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
