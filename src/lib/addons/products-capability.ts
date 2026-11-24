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
import { PhiImageAssetVariantKey } from "@/lib/constants/media";
import { resolvePhiMediaDeliveryUrl, resolvePhiMediaVariantUrl } from "@/lib/media-response";
import { annotateProduct, type PhisProductMedia, type PhisStoredProduct, listProducts, readProduct, registerProduct, removeProduct, setProductState } from "@/db/products.mts";

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
  const { imageMedia, iconMedia, galleryMedia, ...rest } = product;
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

/** The enabled Add-ons that declare a handler for `product.changed`. */
export const listPhisProductListeners = (): string[] => listProductListenersOf(getPhisAddonInstalledManifest());

export function buildPhisAddonProductsCapability(input: {
  /** The calling Add-on: the supplier of what it registers and the author of what it annotates. */
  addonId: string;
  siteId: number;
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
      const page = await listProducts(getPool(), {
        siteId, states, limit, cursor: request.cursor ?? null, ids,
        supplier: request.supplier, publisher: request.publisher, type: request.type, released: publicView ? undefined : request.released,
      });
      return { products: page.products.map((product) => present(product, publicView)!), nextCursor: page.nextCursor };
    },

    async get({ id }) {
      return present(await readProduct(getPool(), siteId, readId(id)), input.unauthenticated === true);
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
