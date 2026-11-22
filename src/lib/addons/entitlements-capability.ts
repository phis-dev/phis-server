import "server-only";

import {
  PHIS_ENTITLEMENT_CORE_SOURCE,
  type PhisEntitlementSubject,
  type PhisEntitlementsCapabilityV1,
} from "@phis/contracts/addon";
import type { PhisProduct, PhisProductId } from "@phis/contracts/addon";

import { schedulePhisAddonEventDelivery } from "./event-trigger.ts";
import { listEntitlementListenersOf } from "./commerce-listeners.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { isPhisProductId, splitPhisProductId } from "./product-draft.ts";
import { getPool } from "@/lib/db";
import {
  ensureEntitlementSubject,
  findEntitlementSubject,
  grantEntitlement,
  isEntitlementSourceAllowed,
  isSubscriptionOfAddon,
  listEntitlements,
  readEntitlementState,
  updateEntitlement,
} from "@/db/entitlements.mts";
import { readProduct } from "@/db/products.mts";

/**
 * `entitlements:v1` for one request (SERVER_ADDONS.md, entitlements:v1).
 *
 * Reading is open to whoever requires the capability. Writing is a source's, and a source is believed in
 * two cases: the Site's operator allowed it -- for every product or for the products of the supplier --
 * or it supplies the product itself and the product is `free`. Every write is the calling Add-on's own --
 * the source is closed over, not passed in -- so another source's entry is simply not found. An
 * unverified hook reaches none of it, reads included: whether somebody holds a product is not for
 * whoever found an unsigned address.
 */

export class PhisAddonEntitlementsError extends Error {}

const REFERENCE_MAX_LENGTH = 190;
const QUANTITY_MAX = 2_000_000_000;

/** The enabled Add-ons that declare a handler for `entitlement.changed`. */
export const listPhisEntitlementListeners = (): string[] => listEntitlementListenersOf(getPhisAddonInstalledManifest());

function readInstant(value: string | null | undefined, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PhisAddonEntitlementsError(`${name} must be an ISO instant.`);
  }
  return new Date(value).toISOString();
}

function readQuantity(value: number | null | undefined, product: Pick<PhisProduct, "counted"> & { id: string }): number | null {
  if (!product.counted) {
    if (value !== undefined && value !== null) {
      throw new PhisAddonEntitlementsError(`Product "${product.id}" does not count; an entry of it carries no quantity.`);
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > QUANTITY_MAX) {
    throw new PhisAddonEntitlementsError(`Product "${product.id}" counts; an entry of it carries a whole quantity of at least 1.`);
  }
  return value;
}

export function buildPhisAddonEntitlementsCapability(input: {
  /** The calling Add-on, which is the source of everything it writes. */
  addonId: string;
  siteId: number;
  actorUserId: number | null;
  /** True when nobody authenticated and no signature stood in for them -- an unverified hook. */
  unauthenticated?: boolean;
}): PhisEntitlementsCapabilityV1 {
  const { addonId, siteId, actorUserId } = input;

  const requireBelievableCaller = (call: string) => {
    if (input.unauthenticated) {
      throw new PhisAddonEntitlementsError(
        `${addonId} called entitlements.${call} from an unverified hook; a hook that touches entitlements declares how its caller can be believed.`,
      );
    }
  };

  /** The subject asked about: the one named, or the acting user's. Null where neither is anybody here. */
  const resolveSubject = async (subject: PhisEntitlementSubject | undefined) => {
    if (subject !== undefined) {
      return typeof subject === "string" ? findEntitlementSubject(getPool(), siteId, subject) : null;
    }
    if (actorUserId == null) return null;
    return findEntitlementSubject(getPool(), siteId, await ensureEntitlementSubject(getPool(), siteId, actorUserId));
  };

  const readProductId = (call: string, product: PhisProductId) => {
    if (!isPhisProductId(product)) {
      throw new PhisAddonEntitlementsError(`${addonId} called entitlements.${call} for "${String(product)}", which is not a product id.`);
    }
    return product;
  };

  /**
   * Whether this source may write for the product: the operator allowed it for every product or for the
   * product's supplier, or it is the supplier and the product is `free`. The supplier is read from the
   * id, so an entry whose product is gone can still be changed by whoever was allowed.
   */
  const requireWritable = async (call: string, id: PhisProductId, product: Pick<PhisProduct, "free"> | null) => {
    requireBelievableCaller(call);
    const { supplier } = splitPhisProductId(readProductId(call, id));
    const ownFree = supplier === addonId && product?.free === true;
    if (!ownFree && !await isEntitlementSourceAllowed(getPool(), siteId, supplier, addonId)) {
      throw new PhisAddonEntitlementsError(`${addonId} may not write entitlements for product "${id}" on this Site.`);
    }
  };

  const readReference = (reference: string) => {
    if (typeof reference !== "string" || !reference.trim() || reference.length > REFERENCE_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(reference)) {
      throw new PhisAddonEntitlementsError(`A reference is 1 to ${REFERENCE_MAX_LENGTH} characters without control characters.`);
    }
    return reference;
  };

  const written = <T>(entry: T): T => {
    // After the commit; the outbox rows are already written, this only spares them the next tick.
    schedulePhisAddonEventDelivery(siteId);
    return entry;
  };

  return {
    async subject() {
      requireBelievableCaller("subject");
      return actorUserId == null ? null : ensureEntitlementSubject(getPool(), siteId, actorUserId);
    },

    async check({ product, subject }) {
      requireBelievableCaller("check");
      // A product nobody registered entitles nobody: its entries are kept and do not count.
      const row = isPhisProductId(product) ? await resolveSubject(subject) : null;
      return readEntitlementState(getPool(), { siteId, subjectId: row?.id ?? null, product });
    },

    async list({ subject, product, resolveBundles }) {
      requireBelievableCaller("list");
      if (resolveBundles !== undefined && typeof resolveBundles !== "boolean") {
        throw new PhisAddonEntitlementsError(`${addonId} called entitlements.list with resolveBundles that is not a boolean.`);
      }
      // Without a subject and without anybody acting there is nobody to list for; a Site-wide read is not offered.
      const row = await resolveSubject(subject);
      return row ? listEntitlements(getPool(), { siteId, subjectId: row.id, product: product ?? null, resolveBundles: resolveBundles === true }) : [];
    },

    async grant({ subject, product, reference, startsAt, endsAt, subscriptionId, quantity }) {
      requireBelievableCaller("grant");
      const id = readProductId("grant", product);
      const found = await readProduct(getPool(), siteId, id);
      if (!found) throw new PhisAddonEntitlementsError(`${addonId} called entitlements.grant for product "${id}", which this Site does not have.`);
      await requireWritable("grant", id, found);
      if (subscriptionId !== undefined) {
        if (endsAt !== undefined && endsAt !== null) {
          throw new PhisAddonEntitlementsError("An entry bound to a subscription has no written end; leave endsAt out.");
        }
        // A subscription belongs to the Add-on that created it: another's, or one this Site does not have, is refused alike.
        if (typeof subscriptionId !== "string" || !await isSubscriptionOfAddon(getPool(), siteId, subscriptionId, addonId)) {
          throw new PhisAddonEntitlementsError(`${addonId} called entitlements.grant with a subscription it did not create on this Site.`);
        }
      }
      const row = typeof subject === "string" ? await findEntitlementSubject(getPool(), siteId, subject) : null;
      if (!row) {
        throw new PhisAddonEntitlementsError(`${addonId} called entitlements.grant for a subject this Site does not have.`);
      }
      const starts = readInstant(startsAt, "startsAt");
      const ends = readInstant(endsAt, "endsAt");
      if (ends && Date.parse(ends) <= Date.parse(starts ?? new Date().toISOString())) {
        throw new PhisAddonEntitlementsError("endsAt must be after the start.");
      }
      const entry = await grantEntitlement(getPool(), {
        siteId, subjectId: row.id, product: id, source: addonId, reference: readReference(reference),
        startsAt: starts, endsAt: ends, quantity: readQuantity(quantity, found), counted: found.counted, subscriptionId: subscriptionId ?? null,
        listeners: listPhisEntitlementListeners(),
      });
      if (!entry) throw new PhisAddonEntitlementsError(`${addonId} called entitlements.grant for product "${id}", which is not active; a new entry needs an active product.`);
      return written(entry);
    },

    async update({ product, reference, endsAt, quantity, suspended }) {
      requireBelievableCaller("update");
      const id = readProductId("update", product);
      // Whether the entry is bound is the entry's to say; the write refuses an end on a bound one.
      // An entry is changed whatever became of its product; the product is read for its quantity rule only.
      const found = await readProduct(getPool(), siteId, id);
      await requireWritable("update", id, found);
      if (quantity !== undefined && !found) {
        throw new PhisAddonEntitlementsError(`${addonId} called entitlements.update with a quantity for product "${id}", which this Site no longer has.`);
      }
      return written(await updateEntitlement(getPool(), {
        siteId, source: addonId, product: id, reference: readReference(reference),
        ...(endsAt !== undefined ? { endsAt: readInstant(endsAt, "endsAt") } : {}),
        ...(quantity !== undefined ? { quantity: readQuantity(quantity, found!) } : {}),
        ...(suspended !== undefined ? { suspended: suspended === true } : {}),
        listeners: listPhisEntitlementListeners(),
      }));
    },

    async revoke({ product, reference }) {
      /*
       * Taking back needs no leave. A source whose leave the operator withdrew must still be able to say
       * that what it stated no longer holds -- a refund after the shop was switched to another -- and it
       * reaches its own entries only. Nor does it need the product to be there.
       */
      requireBelievableCaller("revoke");
      if (!isPhisProductId(product)) return null;
      return written(await updateEntitlement(getPool(), {
        siteId, source: addonId, product, reference: readReference(reference), revoke: true, listeners: listPhisEntitlementListeners(),
      }));
    },
  } satisfies PhisEntitlementsCapabilityV1;
}

/** The source name of an entry the operator wrote by hand. */
export { PHIS_ENTITLEMENT_CORE_SOURCE };
