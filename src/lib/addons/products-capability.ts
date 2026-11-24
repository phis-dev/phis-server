import "server-only";

import type {
  PhisProduct,
  PhisProductDraft,
  PhisProductId,
  PhisProductListInput,
  PhisProductState,
  PhisProductsCapabilityV1,
} from "@phis/contracts/addon";

import { schedulePhisAddonEventDelivery } from "./event-trigger.ts";
import { listProductListenersOf } from "./commerce-listeners.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { isPhisProductId, isPhisProductKey, normalizePhisProductDraft } from "./product-draft.ts";
import { PHIS_PRODUCT_ATTRIBUTES_MAX_BYTES } from "@/lib/constants/products";
import { getPool } from "@/lib/db";
import { getPhisConfigSync } from "@/lib/config";
import { resolvePhiSiteSourceLocale } from "@/lib/config-core";
import { PhiImageAssetVariantKey } from "@/lib/constants/media";
import { resolvePhiLocaleBase, resolvePhiLocaleCapability } from "@/lib/locale";
import { resolvePhiMediaDeliveryUrl, resolvePhiMediaVariantUrl } from "@/lib/media-response";
import { fillSiteMessageTranslations } from "@/lib/translations";
import { notePhiTranslationUse } from "@/db/translation-usage";
import {
  annotateProduct,
  type PhisProductMedia,
  PHIS_PRODUCT_TEXT_FIELDS,
  type PhisProductTextField,
  type PhisStoredProduct,
  listProducts,
  readProduct,
  registerProduct,
  removeProduct,
  setProductState,
} from "@/db/products.mts";

/**
 * `products:v1` for one request (SERVER_ADDONS.md, products:v1).
 *
 * Reading is open to whoever requires the capability. A supplier writes its own products and nobody
 * else's: the calling Add-on is closed over, never passed in, so another supplier's product is simply
 * not found. Any Add-on writes its own attributes entry and no one else's. Releasing, locking and
 * withdrawing another's product are the operator's and are not here.
 *
 * An unverified hook -- a public read point, nobody signed in -- reads the catalogue and nothing else: only
 * `active` products, whatever `states` or `ids` ask for, without `pendingTerms`; a product that is not (or
 * no longer) active is not found. A catalogue is public; what is not yet or no longer in it is not.
 * Attributes are part of a product and so are public. Every write is refused to it.
 */

export class PhisAddonProductsError extends Error {}

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
const STATES: readonly PhisProductState[] = ["draft", "active", "withdrawn", "locked"];
/**
 * The picture's and the icon's Site-relative addresses, as Core addresses its own Media (assets:v1
 * `contentPath`), read now: the delivery for `imagePath` and `iconPath`, the `icon` image variant (64 x 64,
 * fitted whole on a transparent ground) for `imageListPath` and `iconListPath`, which a list or a table
 * shows. Both carry the Asset's revision, so the address changes when the picture does.
 */
const deliveryPath = (media: PhisProductMedia | null) => (media ? resolvePhiMediaDeliveryUrl(media) : null);
const listPath = (media: PhisProductMedia | null) => (media ? resolvePhiMediaVariantUrl(media, PhiImageAssetVariantKey.Icon) : null);

function present(product: PhisStoredProduct, publicView?: false): PhisProduct;
function present(product: PhisStoredProduct | null, publicView?: boolean): PhisProduct | null;
function present(product: PhisStoredProduct | null, publicView = false): PhisProduct | null {
  if (!product) return null;
  const { imageMedia, iconMedia, galleryMedia, textMessages: _textMessages, ...rest } = product;
  // What is not in the catalogue yet is not public: a product shown to everybody has no pending terms.
  if (publicView && product.state !== "active") return null;
  return {
    ...rest,
    ...(publicView ? { pendingTerms: null } : {}),
    imagePath: deliveryPath(imageMedia),
    iconPath: deliveryPath(iconMedia),
    imageListPath: listPath(imageMedia),
    iconListPath: listPath(iconMedia),
    // The gallery's pictures were each accepted as the picture is -- ready, public, in reach -- so every path is a public one.
    gallery: galleryMedia.map((media) => ({ assetId: media.id, path: deliveryPath(media)!, listPath: listPath(media) })),
  };
}

/**
 * A product as a signed-in reader is answered it, the picture's and the icon's addresses read now: what
 * `products:v1` hands an Add-on, and what the operator's directory (`GET /api/site/products`) lists, list
 * paths included.
 */
export function presentPhisProduct(product: PhisStoredProduct): PhisProduct {
  return present(product);
}

const MOVABLE_STATES = new Set<string>(["draft", "active", "withdrawn"]);

/**
 * What a provider is told of a product's word it is asked to translate: the field, in natural language.
 * The stored context names the product as well (`phisProductTextContext`), which is identity and no hint.
 */
const PROVIDER_CONTEXTS: Readonly<Record<"title" | "summary", string>> = { title: "product title", summary: "product summary" };

/** The fields a provider is asked for where nobody translated them: not the description, a Markdown document. */
const FILLED_FIELDS = ["title", "summary"] as const;

/**
 * Products as read in `locale`: each field that has a translation held answers it, a title or a summary
 * that has none is asked of the Site's provider -- one request per field for every product of the read --
 * and kept, and the description stays the source where nobody translated it. In place, on the products
 * handed in; the messages read are noted as used.
 */
async function translateProducts(products: PhisStoredProduct[], input: { siteId: number; locale: string; sourceLocale: string }) {
  const used: number[] = [];
  const answers = new Map<number, string>();
  for (const field of FILLED_FIELDS) {
    const missing = products.flatMap((product) => {
      const message = product.textMessages[field];
      return message && message.translation === null ? [{ msgId: message.msgId, msg: product[field] }] : [];
    });
    const filled = await fillSiteMessageTranslations({
      siteId: input.siteId, locale: input.locale, sourceLocale: input.sourceLocale,
      providerContext: PROVIDER_CONTEXTS[field], messages: missing,
    });
    for (const [msgId, text] of filled) answers.set(msgId, text);
  }
  const translated = products.map((product) => {
    const texts: Partial<Record<PhisProductTextField, string>> = {};
    for (const field of PHIS_PRODUCT_TEXT_FIELDS) {
      const message = product.textMessages[field];
      if (!message) continue;
      used.push(message.msgId);
      const text = message.translation ?? answers.get(message.msgId);
      if (text !== undefined) texts[field] = text;
    }
    return { ...product, ...texts };
  });
  notePhiTranslationUse("site", used);
  return translated;
}

/** The enabled Add-ons that declare a handler for `product.changed`. */
export const listPhisProductListeners = (): string[] => listProductListenersOf(getPhisAddonInstalledManifest());

export function buildPhisAddonProductsCapability(input: {
  /** The calling Add-on: the supplier of what it registers and the author of what it annotates. */
  addonId: string;
  siteId: number;
  /** The Site's key, which names its source language; a read with a `locale` needs it. */
  siteKey: string | null;
  /** True when nobody authenticated and no signature stood in for them -- an unverified hook. */
  unauthenticated?: boolean;
}): PhisProductsCapabilityV1 {
  const { addonId, siteId } = input;

  const requireBelievableCaller = (call: string) => {
    if (input.unauthenticated) {
      throw new PhisAddonProductsError(
        `${addonId} called products.${call} from an unverified hook; a hook that touches products declares how its caller can be believed.`,
      );
    }
  };

  const written = <T>(result: T): T => {
    // After the commit; the outbox rows are already written, this only spares them the next tick.
    schedulePhisAddonEventDelivery(siteId);
    return result;
  };

  const readId = (id: PhisProductId) => {
    if (!isPhisProductId(id)) throw new PhisAddonProductsError("A product id looks like @scope/name:key.");
    return id;
  };

  /**
   * The language a read answers its words in, or null for the words as written: absent, null, the Site's
   * source language, or a language no translation is kept in. Anything but a string or null is refused.
   */
  const readLocale = (locale: unknown) => {
    if (locale === undefined || locale === null) return null;
    if (typeof locale !== "string") throw new PhisAddonProductsError("locale is a locale key such as de, or null for the texts as written.");
    const capability = resolvePhiLocaleCapability(locale);
    if (!capability) return null;
    if (!input.siteKey) throw new Error("products:v1 was built without the Site's key; a read in a language needs its source language.");
    const sourceLocale = resolvePhiSiteSourceLocale(getPhisConfigSync(), input.siteKey);
    return resolvePhiLocaleBase(capability.locale) === resolvePhiLocaleBase(sourceLocale) ? null : { locale: capability.locale, sourceLocale };
  };

  const inLocale = async (products: PhisStoredProduct[], read: { locale: string; sourceLocale: string } | null) =>
    read ? translateProducts(products, { siteId, ...read }) : products;

  const readKey = (key: string) => {
    if (!isPhisProductKey(key)) throw new PhisAddonProductsError("A product key matches ^[a-z][a-z0-9.-]*$ and has at most 96 characters.");
    return key;
  };

  return {
    async list(request: PhisProductListInput = {}) {
      const publicView = input.unauthenticated === true;
      const ids = request.ids;
      if (ids !== undefined && (!Array.isArray(ids) || ids.length > LIST_LIMIT_MAX || !ids.every(isPhisProductId))) {
        throw new PhisAddonProductsError(`ids is a list of at most ${LIST_LIMIT_MAX} product ids.`);
      }
      // Named products are asked for whatever state they are in, unless states says otherwise.
      const states = publicView ? ["active" as const]
        : request.states === undefined ? (ids === undefined ? ["active" as const] : [...STATES]) : request.states;
      if (!Array.isArray(states) || states.length === 0 || !states.every((state) => STATES.includes(state))) {
        throw new PhisAddonProductsError("states is a non-empty list of draft, active, withdrawn or locked.");
      }
      const limit = request.limit ?? LIST_LIMIT_DEFAULT;
      if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
        throw new PhisAddonProductsError(`limit is a whole number from 1 to ${LIST_LIMIT_MAX}.`);
      }
      for (const name of ["supplier", "publisher", "type"] as const) {
        if (request[name] !== undefined && typeof request[name] !== "string") throw new PhisAddonProductsError(`${name} is a string.`);
      }
      if (request.released !== undefined && typeof request.released !== "boolean") throw new PhisAddonProductsError("released is a boolean.");
      const read = readLocale(request.locale);
      const page = await listProducts(getPool(), {
        siteId, states, limit, cursor: request.cursor ?? null, ids, locale: read?.locale ?? null,
        supplier: request.supplier, publisher: request.publisher, type: request.type, released: publicView ? undefined : request.released,
      });
      const products = await inLocale(page.products, read);
      return { products: products.map((product) => present(product, publicView)!), nextCursor: page.nextCursor };
    },

    async get({ id, locale }) {
      const publicView = input.unauthenticated === true;
      const read = readLocale(locale);
      const product = await readProduct(getPool(), siteId, readId(id), read?.locale ?? null);
      // What a public read would not be answered is not translated for it either.
      if (!product || (publicView && product.state !== "active")) return null;
      return present((await inLocale([product], read))[0]!, publicView);
    },

    async register(draft: PhisProductDraft) {
      requireBelievableCaller("register");
      const normalized = normalizePhisProductDraft(draft, `${addonId}:${draft?.key}` as PhisProductId);
      const result = await registerProduct(getPool(), {
        siteId, supplier: addonId, draft: normalized, listeners: listPhisProductListeners(),
      });
      return written(present(result.product));
    },

    async setState({ key, state }) {
      requireBelievableCaller("setState");
      if (!MOVABLE_STATES.has(state)) throw new PhisAddonProductsError("state is draft, active or withdrawn; locking is the operator's.");
      return written(present(await setProductState(getPool(), {
        siteId, supplier: addonId, key: readKey(key), state, listeners: listPhisProductListeners(),
      })));
    },

    async remove({ key }) {
      requireBelievableCaller("remove");
      return removeProduct(getPool(), { siteId, supplier: addonId, key: readKey(key) });
    },

    async annotate({ id, data }) {
      requireBelievableCaller("annotate");
      readId(id);
      if (data !== null) {
        if (typeof data !== "object" || Array.isArray(data)) throw new PhisAddonProductsError("data is an object, or null to take the attributes away.");
        let serialized: string | undefined;
        try { serialized = JSON.stringify(data); } catch { serialized = undefined; }
        if (serialized === undefined) throw new PhisAddonProductsError("data has to be JSON.");
        if (Buffer.byteLength(serialized) > PHIS_PRODUCT_ATTRIBUTES_MAX_BYTES) {
          throw new PhisAddonProductsError(`The attributes of one Add-on take at most ${PHIS_PRODUCT_ATTRIBUTES_MAX_BYTES} bytes as JSON.`);
        }
      }
      return written(present(await annotateProduct(getPool(), {
        siteId, productId: id, addonId, data: data as Record<string, unknown> | null, listeners: listPhisProductListeners(),
      })));
    },
  } satisfies PhisProductsCapabilityV1;
}
