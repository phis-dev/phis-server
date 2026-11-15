import "server-only";

import {
  PHIS_ENTITLEMENT_CORE_SOURCE,
  type PhisEntitlementKind,
  type PhisEntitlementKindId,
  type PhisEntitlementSubject,
  type PhisEntitlementsCapabilityV1,
} from "@phis/contracts/addon";

import { schedulePhisAddonEventDelivery } from "./event-trigger.ts";
import { isPhisEntitlementKindId, listEntitlementKindsOf, listEntitlementListenersOf } from "./entitlement-catalogue.ts";
import { getPhisAddonInstalledManifest } from "./installed.ts";
import { getPool } from "@/lib/db";
import {
  ensureEntitlementSubject,
  findEntitlementSubject,
  grantEntitlement,
  isEntitlementSourceAllowed,
  listEntitlements,
  readEntitlementState,
  updateEntitlement,
} from "@/db/entitlements.mts";

/**
 * `entitlements:v1` for one request (SERVER_ADDONS.md, entitlements:v1).
 *
 * Reading is open to whoever requires the capability. Writing is a source's, and a source is believed for
 * a kind in two cases: it declared the kind itself, or the Site's admin allowed it. Every write is the
 * calling Add-on's own -- the source is closed over, not passed in -- so another source's entry is simply
 * not found. An unverified hook reaches none of it, reads included: whether somebody is entitled is not
 * for whoever found an unsigned address.
 */

export class PhisAddonEntitlementsError extends Error {}

const REFERENCE_MAX_LENGTH = 190;
const QUANTITY_MAX = 2_000_000_000;

/** The kinds the enabled Add-ons declare: the installed manifests are the catalogue. */
export const listPhisEntitlementKinds = (): PhisEntitlementKind[] => listEntitlementKindsOf(getPhisAddonInstalledManifest());

/** The enabled Add-ons that declare a handler for `entitlement.changed`. */
export const listPhisEntitlementListeners = (): string[] => listEntitlementListenersOf(getPhisAddonInstalledManifest());

function readInstant(value: string | null | undefined, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PhisAddonEntitlementsError(`${name} must be an ISO instant.`);
  }
  return new Date(value).toISOString();
}

function readQuantity(value: number | null | undefined, kind: PhisEntitlementKind): number | null {
  if (!kind.counted) {
    if (value !== undefined && value !== null) {
      throw new PhisAddonEntitlementsError(`Kind "${kind.id}" does not count; an entry of it carries no quantity.`);
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > QUANTITY_MAX) {
    throw new PhisAddonEntitlementsError(`Kind "${kind.id}" counts; an entry of it carries a whole quantity of at least 1.`);
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

  const declaredKind = (kind: PhisEntitlementKindId) => listPhisEntitlementKinds().find((candidate) => candidate.id === kind) ?? null;

  /** The kind a write names, if this source may write it. */
  const requireWritableKind = async (call: string, kind: PhisEntitlementKindId) => {
    requireBelievableCaller(call);
    const declared = isPhisEntitlementKindId(kind) ? declaredKind(kind) : null;
    if (!declared) {
      throw new PhisAddonEntitlementsError(`${addonId} called entitlements.${call} for "${String(kind)}", which no enabled Add-on declares.`);
    }
    if (declared.addonId !== addonId && !await isEntitlementSourceAllowed(getPool(), siteId, declared.id, addonId)) {
      throw new PhisAddonEntitlementsError(`${addonId} may not write entitlements of kind "${declared.id}" on this Site.`);
    }
    return declared;
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
    async kinds() {
      requireBelievableCaller("kinds");
      return listPhisEntitlementKinds();
    },

    async subject() {
      requireBelievableCaller("subject");
      return actorUserId == null ? null : ensureEntitlementSubject(getPool(), siteId, actorUserId);
    },

    async check({ kind, subject }) {
      requireBelievableCaller("check");
      // A kind nobody declares entitles nobody: its entries are kept and do not count.
      const declared = isPhisEntitlementKindId(kind) ? declaredKind(kind) : null;
      const row = declared ? await resolveSubject(subject) : null;
      return readEntitlementState(getPool(), { siteId, subjectId: row?.id ?? null, kind, counted: declared?.counted === true });
    },

    async list({ subject, kind }) {
      requireBelievableCaller("list");
      // Without a subject and without anybody acting there is nobody to list for; a Site-wide read is not offered.
      const row = await resolveSubject(subject);
      return row ? listEntitlements(getPool(), { siteId, subjectId: row.id, kind: kind ?? null }) : [];
    },

    async grant({ subject, kind, reference, startsAt, endsAt, quantity }) {
      const declared = await requireWritableKind("grant", kind);
      const row = typeof subject === "string" ? await findEntitlementSubject(getPool(), siteId, subject) : null;
      if (!row) {
        throw new PhisAddonEntitlementsError(`${addonId} called entitlements.grant for a subject this Site does not have.`);
      }
      const starts = readInstant(startsAt, "startsAt");
      const ends = readInstant(endsAt, "endsAt");
      if (ends && Date.parse(ends) <= Date.parse(starts ?? new Date().toISOString())) {
        throw new PhisAddonEntitlementsError("endsAt must be after the start.");
      }
      return written(await grantEntitlement(getPool(), {
        siteId, subjectId: row.id, kind: declared.id, source: addonId, reference: readReference(reference),
        startsAt: starts, endsAt: ends, quantity: readQuantity(quantity, declared), listeners: listPhisEntitlementListeners(),
      }));
    },

    async update({ kind, reference, endsAt, quantity, suspended }) {
      const declared = await requireWritableKind("update", kind);
      return written(await updateEntitlement(getPool(), {
        siteId, source: addonId, kind: declared.id, reference: readReference(reference),
        ...(endsAt !== undefined ? { endsAt: readInstant(endsAt, "endsAt") } : {}),
        ...(quantity !== undefined ? { quantity: readQuantity(quantity, declared) } : {}),
        ...(suspended !== undefined ? { suspended: suspended === true } : {}),
        listeners: listPhisEntitlementListeners(),
      }));
    },

    async revoke({ kind, reference }) {
      /*
       * Taking back needs no leave. A source whose leave the admin withdrew must still be able to say
       * that what it stated no longer holds -- a refund after the shop was switched to another kind --
       * and it reaches its own entries only.
       */
      requireBelievableCaller("revoke");
      if (!isPhisEntitlementKindId(kind)) return null;
      return written(await updateEntitlement(getPool(), {
        siteId, source: addonId, kind, reference: readReference(reference), revoke: true, listeners: listPhisEntitlementListeners(),
      }));
    },
  } satisfies PhisEntitlementsCapabilityV1;
}

/** The source name of an entry the operator wrote by hand. */
export { PHIS_ENTITLEMENT_CORE_SOURCE, isPhisEntitlementKindId };
