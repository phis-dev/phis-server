import "server-only";

import {
  PHIS_ENTITLEMENT_CORE_SOURCE,
  PHIS_ENTITLEMENT_NAMED_MAX,
  PhisEntitlementFlag,
  PhisEntitlementListFlag,
  PhisProductFlag,
  type PhisEntitlementSubject,
  type PhisEntitlementsCapabilityV1,
} from "@phis/contracts/addon";
import type { PhisProduct, PhisProductId } from "@phis/contracts/addon";

import { schedulePhisAddonEventDelivery } from "./event-trigger.ts";
import { listEntitlementListenersOf } from "./commerce-listeners.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { isPhisProductId, splitPhisProductId } from "./product-draft.ts";
import { PHIS_SITE_ACCESS } from "./contract.ts";
import type { PhisSiteAccessHolder } from "./role-inclusion.ts";
import { getPool } from "@/lib/db";
import { PHIS_ENTITLEMENT_LIST_MAX } from "@/lib/constants/products";
import {
  ensureEntitlementSubject,
  ensureMemberEntitlementSubject,
  findEntitlementSubject,
  grantEntitlement,
  isEntitlementSourceAllowed,
  isSubscriptionOfAddon,
  listEntitlements,
  listNamedEntitlements,
  readEntitlementState,
  readEntitlementStates,
  redeliverEntitlementChanged,
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
 *
 * `subjectForUser` hands out another person's subject, which is staff acting on their behalf: it asks the
 * acting user's Site access, `accounting` or `support`, from the request's one read of their authorization
 * snapshot, shared with `authorization:v1` and `roles:v1`. `redeliver` asks the same snapshot for
 * `accounting` alone: queuing an event for every holder of a product is a commercial act, not a person's.
 */

export class PhisAddonEntitlementsError extends Error {}

const REFERENCE_MAX_LENGTH = 190;
/** The most products one `checkMany` answers for (the contract's bound). */
const CHECK_MANY_MAX = 100;
/** The most subjects one `list` answers for (the contract's bound). */
const LIST_SUBJECTS_MAX = 100;
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

/** Every bit `list` knows; another is refused rather than read as nothing. */
const LIST_FLAGS = PhisEntitlementListFlag.ResolveBundles;

function readFlagBits(value: unknown, allowed: number, name: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || (value & ~allowed) !== 0) {
    throw new PhisAddonEntitlementsError(`${name} carries a bit that is not accepted here.`);
  }
  return value;
}

function readQuantity(value: number | null | undefined, product: Pick<PhisProduct, "flags"> & { id: string }): number | null {
  if ((product.flags & PhisProductFlag.Counted) === 0) {
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
  /** The actor's Site accesses, read once for the request (`buildPhisAddonCapabilities`). */
  readSiteAccess: () => Promise<PhisSiteAccessHolder>;
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
  const requireWritable = async (call: string, id: PhisProductId, product: Pick<PhisProduct, "flags"> | null) => {
    requireBelievableCaller(call);
    const { supplier } = splitPhisProductId(readProductId(call, id));
    const ownFree = supplier === addonId && product !== null && (product.flags & PhisProductFlag.Free) !== 0;
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

  /** A listing longer than the bound is refused, never cut: a part of it would read as all of it. */
  const whole = (entries: Awaited<ReturnType<typeof listEntitlements>>) => {
    if (entries.length > PHIS_ENTITLEMENT_LIST_MAX) {
      throw new PhisAddonEntitlementsError(
        `${addonId} called entitlements.list for more than ${PHIS_ENTITLEMENT_LIST_MAX} entries; ask for fewer subjects or one product.`,
      );
    }
    return entries;
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

    async checkMany({ products, subject }) {
      requireBelievableCaller("checkMany");
      if (!Array.isArray(products) || products.length > CHECK_MANY_MAX) {
        throw new PhisAddonEntitlementsError(`${addonId} called entitlements.checkMany with products that is not a list of at most ${CHECK_MANY_MAX} product ids.`);
      }
      const ids = products.map((product) => readProductId("checkMany", product));
      if (ids.length === 0) return [];
      const row = await resolveSubject(subject);
      return readEntitlementStates(getPool(), { siteId, subjectId: row?.id ?? null, products: ids });
    },

    async subjectForUser({ userId }) {
      requireBelievableCaller("subjectForUser");
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new PhisAddonEntitlementsError(`${addonId} called entitlements.subjectForUser with a userId that is not a positive whole number.`);
      }
      const holds = actorUserId == null ? null : await input.readSiteAccess();
      if (!holds || !(holds(PHIS_SITE_ACCESS.accounting) || holds(PHIS_SITE_ACCESS.support))) {
        throw new PhisAddonEntitlementsError(
          `${addonId} called entitlements.subjectForUser for a person acting without the Site access accounting or support; another member's subject is for staff acting on their behalf.`,
        );
      }
      return ensureMemberEntitlementSubject(getPool(), siteId, userId);
    },

    async redeliver({ product }) {
      requireBelievableCaller("redeliver");
      const id = readProductId("redeliver", product);
      const holds = actorUserId == null ? null : await input.readSiteAccess();
      if (!holds || !holds(PHIS_SITE_ACCESS.accounting)) {
        throw new PhisAddonEntitlementsError(
          `${addonId} called entitlements.redeliver for a person acting without the Site access accounting; delivering a product's holders again is accounting's to ask.`,
        );
      }
      // The listener rule every other entitlement.changed row is written by: enabled and declaring the handler.
      if (!listPhisEntitlementListeners().includes(addonId)) {
        throw new PhisAddonEntitlementsError(
          `${addonId} called entitlements.redeliver without a handler for entitlement.changed in its manifest; there is nothing to deliver to.`,
        );
      }
      // A product this Site lacks, or one that is locked, is held by nobody: nothing is queued.
      const queued = await redeliverEntitlementChanged(getPool(), { siteId, addonId, product: id });
      return { queued: queued > 0 ? written(queued) : queued };
    },

    async list({ subject, subjects, product, flags }) {
      requireBelievableCaller("list");
      const resolveBundles = (readFlagBits(flags, LIST_FLAGS, `${addonId} called entitlements.list with flags that`) & PhisEntitlementListFlag.ResolveBundles) !== 0;
      if (subjects !== undefined) {
        if (subject !== undefined) {
          throw new PhisAddonEntitlementsError(`${addonId} called entitlements.list with both subject and subjects; one names whom it lists.`);
        }
        if (!Array.isArray(subjects) || subjects.length > LIST_SUBJECTS_MAX || subjects.some((entry) => typeof entry !== "string")) {
          throw new PhisAddonEntitlementsError(`${addonId} called entitlements.list with subjects that is not a list of at most ${LIST_SUBJECTS_MAX} subjects.`);
        }
        if (subjects.length === 0) return [];
        // One statement for all of them; a reference that is nobody here simply has no entries.
        return whole(await listEntitlements(getPool(), { siteId, subjectReferences: [...new Set(subjects)], product: product ?? null, resolveBundles }));
      }
      // Without a subject and without anybody acting there is nobody to list for; a Site-wide read is not offered.
      const row = await resolveSubject(subject);
      return row ? whole(await listEntitlements(getPool(), { siteId, subjectId: row.id, product: product ?? null, resolveBundles })) : [];
    },

    async listNamed({ entries }) {
      requireBelievableCaller("listNamed");
      if (!Array.isArray(entries) || entries.length > PHIS_ENTITLEMENT_NAMED_MAX) {
        throw new PhisAddonEntitlementsError(`${addonId} called entitlements.listNamed with entries that is not a list of at most ${PHIS_ENTITLEMENT_NAMED_MAX} names.`);
      }
      if (entries.length === 0) return [];
      const names = entries.map((entry) => {
        if (!entry || typeof entry !== "object" || typeof entry.source !== "string" || typeof entry.reference !== "string"
          || (entry.subject !== undefined && typeof entry.subject !== "string")) {
          throw new PhisAddonEntitlementsError(`${addonId} called entitlements.listNamed with a name that is not { source, reference, product, subject? }.`);
        }
        return { source: entry.source, reference: entry.reference, product: readProductId("listNamed", entry.product), subject: entry.subject };
      });
      // A name without a subject is the acting person's; with nobody acting it names nobody's entry.
      const acting = names.some((name) => name.subject === undefined) && actorUserId != null
        ? await ensureEntitlementSubject(getPool(), siteId, actorUserId) : null;
      return listNamedEntitlements(getPool(), { siteId, entries: names, fallbackSubject: acting });
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
        startsAt: starts, endsAt: ends, quantity: readQuantity(quantity, found), counted: (found.flags & PhisProductFlag.Counted) !== 0, subscriptionId: subscriptionId ?? null,
        listeners: listPhisEntitlementListeners(),
      });
      if (!entry) throw new PhisAddonEntitlementsError(`${addonId} called entitlements.grant for product "${id}", which is not active; a new entry needs an active product.`);
      return written(entry);
    },

    async update({ product, reference, endsAt, quantity, setFlags, clearFlags, subscriptionId }) {
      requireBelievableCaller("update");
      const id = readProductId("update", product);
      const set = readFlagBits(setFlags, PhisEntitlementFlag.Suspended, `${addonId} called entitlements.update with setFlags that`);
      const clear = readFlagBits(clearFlags, PhisEntitlementFlag.Suspended, `${addonId} called entitlements.update with clearFlags that`);
      if ((set & clear) !== 0) {
        throw new PhisAddonEntitlementsError(`${addonId} called entitlements.update setting and clearing the same bit.`);
      }
      // Only away from a subscription, never onto one.
      if (subscriptionId !== undefined && subscriptionId !== null) {
        throw new PhisAddonEntitlementsError(`${addonId} called entitlements.update with a subscriptionId; an entry is only taken off its subscription (null).`);
      }
      // Whether the entry is bound is the entry's to say; the write refuses an end on one that stays bound.
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
        setFlags: set, clearFlags: clear,
        ...(subscriptionId === null ? { unbind: true } : {}),
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
