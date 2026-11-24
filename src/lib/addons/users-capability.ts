import "server-only";

import {
  PHIS_USERS_DESCRIBE_MAX,
  PhisSiteAddressFlags,
  type PhisAddonUsersAccess,
  type PhisSiteAddressInput,
  type PhisUserDescription,
  type PhisUserField,
  type PhisUsersCapabilityV1,
} from "@phis/contracts/users";

import { PHIS_SITE_ACCESS } from "./contract.ts";
import type { PhisSiteAccessHolder } from "./role-inclusion.ts";
import { getPool } from "@/lib/db";
import { readPhisAddonUsersGrant } from "@/db/users-grants.mts";
import {
  createPhisSiteAddress,
  findPhisSiteSubjectMember,
  readPhisCurrentSiteAddresses,
  readPhisSiteAddressesByIds,
  readPhisUserDescriptions,
  recordPhisUsersAccess,
} from "@/db/site-users";
import {
  isPhisUserField,
  PHIS_SITE_ADDRESS_DEFAULT_FLAGS,
  PHIS_SITE_ADDRESS_WRITABLE_FLAGS,
  PHIS_USER_FIELD_ALL_BITS,
  PHIS_USER_FIELD_BITS,
  phisUserFieldBitsOf,
  PhisUsersAccessOperation,
  PhisUsersAccessRoad,
  type PhisUsersAccessRoadValue,
} from "@/lib/constants/users";

export class PhisAddonUsersError extends Error {}

/** The most addresses one `addresses` call names: an order list's page, not the Site's book. */
export const PHIS_USERS_ADDRESSES_MAX = 1000;

const NAME = PHIS_USER_FIELD_BITS.name;
const EMAIL = PHIS_USER_FIELD_BITS.email;
const PHONE = PHIS_USER_FIELD_BITS.phone;
const ADDRESS = PHIS_USER_FIELD_BITS.address;

/** The widths of `phis.site_addresses`, which an input is held to before it reaches a statement. */
const ADDRESS_TEXT_LIMITS = {
  companyName: 256,
  name: 256,
  line1: 256,
  line2: 256,
  postalCode: 32,
  city: 128,
  region: 128,
} as const;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * `@phis/server/users:v1`: a person of the Site, field by field by the acting person (SERVER_ADDONS.md,
 * users:v1).
 *
 * Three roads, decided per person asked about and never by the Add-on:
 *
 * - **staff**: a person acting with the Site access `support` (name, e-mail, telephone) or `accounting`
 *   (those and the addresses; a Site Admin holds it too), from the request's one read of their
 *   authorization snapshot, shared with `authorization:v1`;
 * - **self**: the person acting for themself, who reads all of their own;
 * - **background**: nobody acting and system authority -- a job, an event handler, a verified hook -- on the
 *   Site's grant (`phis.addon_users_grants`), the fields both granted and still asked in the manifest's
 *   `users.background`.
 *
 * Anybody else -- a request nobody signed in to, an operator's -- reads nothing, and may only write a
 * guest's address, which is what a checkout without an account does. A field the manifest's
 * `users.fields` does not list is refused on every road; a field that is listed but not readable on the
 * road is absent from the answer. Every answer that carries personal data is written to the Site's
 * access log first (`phis.users_access_log`).
 */
export function buildPhisAddonUsersCapability(input: {
  addonId: string;
  siteId: number;
  actorUserId: number | null;
  /** The manifest's `users`; the manifest reader requires it with the capability. */
  access: PhisAddonUsersAccess | undefined;
  /** The actor's Site accesses, read once for the request (`buildPhisAddonCapabilities`). */
  readSiteAccess: () => Promise<PhisSiteAccessHolder>;
  /** Nobody acting and system authority: a job, an event handler, a verified hook. */
  background: boolean;
  /** True when nobody authenticated and no signature stood in for them -- an unverified hook. */
  unauthenticated?: boolean;
}): PhisUsersCapabilityV1 {
  const { addonId, siteId, actorUserId } = input;
  const listed = phisUserFieldBitsOf((input.access?.fields ?? []).filter(isPhisUserField));
  const listedBackground = phisUserFieldBitsOf((input.access?.background ?? []).filter(isPhisUserField)) & listed;

  const requireBelievableCaller = (call: string) => {
    if (input.unauthenticated) {
      throw new PhisAddonUsersError(
        `${addonId} called users.${call} from an unverified hook; nothing tells its caller apart from anybody who found the address.`,
      );
    }
  };

  /** What the actor reads of somebody else: support's three fields, accounting's (and the Site Admin's) four. */
  let staff: Promise<number> | undefined;
  const staffBits = () => {
    if (actorUserId == null) return Promise.resolve(0);
    staff ??= input.readSiteAccess().then((holds) => {
      if (holds(PHIS_SITE_ACCESS.accounting) || holds(PHIS_SITE_ACCESS.siteAdmin)) return PHIS_USER_FIELD_ALL_BITS & listed;
      if (holds(PHIS_SITE_ACCESS.support)) return (NAME | EMAIL | PHONE) & listed;
      return 0;
    });
    return staff;
  };
  /** What a job or an event handler reads: the grant, as far as the manifest still asks for it. */
  let background: Promise<number> | undefined;
  const backgroundBits = () => {
    if (!input.background || actorUserId != null || listedBackground === 0) return Promise.resolve(0);
    background ??= readPhisAddonUsersGrant(getPool(), { siteId, addonId }).then((granted) => granted & listedBackground);
    return background;
  };

  const requireListed = (call: string, bits: number) => {
    if ((bits & ~listed) !== 0) {
      throw new PhisAddonUsersError(
        `${addonId} called users.${call} for a field its manifest does not list in users.fields; such a field is refused on every road.`,
      );
    }
  };

  return Object.freeze({
    async describe(describeInput) {
      requireBelievableCaller("describe");
      const subjects = describeInput?.subjects;
      const fields = describeInput?.fields;
      if (!Array.isArray(subjects) || subjects.some((subject) => typeof subject !== "string")) {
        throw new PhisAddonUsersError(`${addonId} called users.describe with subjects that are not a list of entitlement subjects.`);
      }
      if (subjects.length > PHIS_USERS_DESCRIBE_MAX) {
        throw new PhisAddonUsersError(`${addonId} called users.describe for more than ${PHIS_USERS_DESCRIBE_MAX} people.`);
      }
      if (!Array.isArray(fields) || !fields.every(isPhisUserField)) {
        throw new PhisAddonUsersError(`${addonId} called users.describe with fields that are not users:v1 fields.`);
      }
      const asked = phisUserFieldBitsOf(fields as PhisUserField[]);
      requireListed("describe", asked);

      const bare = () => subjects.map((subject) => ({ subject }));
      const staffMay = asked & await staffBits();
      const selfMay = actorUserId != null ? asked & listed : 0;
      const backgroundMay = asked & await backgroundBits();
      const possible = staffMay | selfMay | backgroundMay;
      if (subjects.length === 0 || possible === 0) {
        // Nothing is read that nobody may be told.
        return bare();
      }

      const rows = await readPhisUserDescriptions({
        siteId,
        subjects,
        profile: (possible & (NAME | PHONE)) !== 0,
        email: (possible & EMAIL) !== 0,
      });
      const answers = rows.map((row) => {
        if (!row.member || row.userId == null) {
          return { row, road: null, bits: 0 };
        }
        const road: PhisUsersAccessRoadValue = actorUserId == null
          ? PhisUsersAccessRoad.Background
          : row.userId === actorUserId ? PhisUsersAccessRoad.Self : PhisUsersAccessRoad.Staff;
        const bits = road === PhisUsersAccessRoad.Background ? backgroundMay
          : road === PhisUsersAccessRoad.Self ? selfMay : staffMay;
        return { row, road, bits };
      });
      const addresses = await readPhisCurrentSiteAddresses(
        siteId,
        answers.filter((answer) => (answer.bits & ADDRESS) !== 0).map((answer) => answer.row.userId!),
      );

      const described: PhisUserDescription[] = answers.map(({ row, bits }) => {
        const description: PhisUserDescription = { subject: row.subject };
        if (bits === 0) return description;
        const profile = row.profile;
        return {
          ...description,
          ...((bits & NAME) !== 0 && profile
            ? { name: { firstName: profile.firstName, lastName: profile.lastName, displayName: profile.displayName, companyName: profile.companyName } }
            : {}),
          ...((bits & EMAIL) !== 0 ? { email: row.email } : {}),
          ...((bits & PHONE) !== 0 ? { phone: { phone: profile?.phone ?? null, mobile: profile?.mobile ?? null } } : {}),
          ...((bits & ADDRESS) !== 0 ? { addresses: addresses.get(row.userId!) ?? [] } : {}),
        };
      });

      // One log entry per road that carried anything, before anything is handed over.
      for (const road of [PhisUsersAccessRoad.Staff, PhisUsersAccessRoad.Self, PhisUsersAccessRoad.Background]) {
        const carried = answers.filter((answer) => answer.road === road && answer.bits !== 0);
        if (carried.length === 0) continue;
        await recordPhisUsersAccess(null, {
          siteId,
          addonId,
          actorUserId,
          road,
          operation: PhisUsersAccessOperation.Describe,
          subjects: carried.map((answer) => answer.row.subject),
          addressIds: carried.flatMap((answer) => (addresses.get(answer.row.userId!) ?? []).map((address) => address.id)),
          fields: carried.reduce((mask, answer) => mask | answer.bits, 0),
        });
      }
      return described;
    },

    async addresses(addressesInput) {
      requireBelievableCaller("addresses");
      requireListed("addresses", ADDRESS);
      const ids = addressesInput?.ids;
      if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        throw new PhisAddonUsersError(`${addonId} called users.addresses with ids that are not address ids.`);
      }
      if (ids.length > PHIS_USERS_ADDRESSES_MAX) {
        throw new PhisAddonUsersError(`${addonId} called users.addresses for more than ${PHIS_USERS_ADDRESSES_MAX} addresses.`);
      }
      if (ids.length === 0) return [];
      // The widest road the caller stands on: anybody's on the Site, or only the acting person's own.
      let road: PhisUsersAccessRoadValue;
      let ownerUserId: number | null = null;
      if ((await staffBits() & ADDRESS) !== 0) {
        road = PhisUsersAccessRoad.Staff;
      } else if (actorUserId != null) {
        road = PhisUsersAccessRoad.Self;
        ownerUserId = actorUserId;
      } else if ((await backgroundBits() & ADDRESS) !== 0) {
        road = PhisUsersAccessRoad.Background;
      } else {
        return [];
      }
      const found = await readPhisSiteAddressesByIds({ siteId, ids, ownerUserId });
      if (found.length > 0) {
        await recordPhisUsersAccess(null, {
          siteId,
          addonId,
          actorUserId,
          road,
          operation: PhisUsersAccessOperation.Addresses,
          subjects: found.flatMap((address) => (address.subject ? [address.subject] : [])),
          addressIds: found.map((address) => address.id),
          fields: ADDRESS,
        });
      }
      return found;
    },

    async createAddress(createInput) {
      requireBelievableCaller("createAddress");
      requireListed("createAddress", ADDRESS);
      const address = readAddressInput(addonId, createInput?.address);
      const flags = readAddressFlags(addonId, createInput?.flags);
      const replaces = createInput?.replaces ?? null;
      if (replaces !== null && (!Number.isSafeInteger(replaces) || replaces <= 0)) {
        throw new PhisAddonUsersError(`${addonId} called users.createAddress with replaces that is no address id.`);
      }
      const subject = createInput?.subject;

      let road: PhisUsersAccessRoadValue;
      let userId: number | null = null;
      if (subject === null) {
        // A guest's address: what the caller just gave is all it is answered, so nobody is refused it.
        if (replaces !== null || (flags & PHIS_SITE_ADDRESS_DEFAULT_FLAGS) !== 0) {
          throw new PhisAddonUsersError(`${addonId} called users.createAddress for a guest with replaces or a default; a guest's address follows none and is nobody's default.`);
        }
        road = (await staffBits() & ADDRESS) !== 0 ? PhisUsersAccessRoad.Staff
          : input.background && actorUserId == null ? PhisUsersAccessRoad.Background
            : PhisUsersAccessRoad.Checkout;
      } else {
        if (typeof subject !== "string" || !subject) {
          throw new PhisAddonUsersError(`${addonId} called users.createAddress with a subject that is not an entitlement subject.`);
        }
        const person = await findPhisSiteSubjectMember(siteId, subject);
        if (!person?.member) {
          throw new PhisAddonUsersError(`${addonId} called users.createAddress for a subject that is no member of this Site.`);
        }
        if (actorUserId != null && person.userId === actorUserId) {
          road = PhisUsersAccessRoad.Self;
        } else if ((await staffBits() & ADDRESS) !== 0) {
          road = PhisUsersAccessRoad.Staff;
        } else {
          throw new PhisAddonUsersError(
            `${addonId} called users.createAddress for somebody else without an acting person holding the Site access accounting; a person writes their own addresses, accounting a member's.`,
          );
        }
        userId = person.userId;
      }

      const written = await createPhisSiteAddress({ siteId, userId, address, flags, replaces });
      await recordPhisUsersAccess(null, {
        siteId,
        addonId,
        actorUserId,
        road,
        operation: PhisUsersAccessOperation.CreateAddress,
        subjects: written.subject ? [written.subject] : [],
        addressIds: [written.id],
        fields: ADDRESS,
      });
      return written;
    },
  } satisfies PhisUsersCapabilityV1);
}

/** The text of an address as Core stores it: trimmed, empty optional parts as null, held to the columns. */
function readAddressInput(addonId: string, value: unknown): PhisSiteAddressInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PhisAddonUsersError(`${addonId} called users.createAddress without an address.`);
  }
  const record = value as Record<string, unknown>;
  const text = (key: keyof typeof ADDRESS_TEXT_LIMITS, required: boolean): string | null => {
    const raw = record[key];
    if (raw === undefined || raw === null) {
      if (required) throw new PhisAddonUsersError(`${addonId} called users.createAddress without address.${key}.`);
      return null;
    }
    if (typeof raw !== "string" || CONTROL_CHARACTERS.test(raw)) {
      throw new PhisAddonUsersError(`${addonId} called users.createAddress with address.${key} that is no line of text.`);
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      if (required) throw new PhisAddonUsersError(`${addonId} called users.createAddress with an empty address.${key}.`);
      return null;
    }
    if (trimmed.length > ADDRESS_TEXT_LIMITS[key]) {
      throw new PhisAddonUsersError(`${addonId} called users.createAddress with address.${key} longer than ${ADDRESS_TEXT_LIMITS[key]} characters.`);
    }
    return trimmed;
  };
  const country = typeof record.country === "string" ? record.country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/u.test(country)) {
    throw new PhisAddonUsersError(`${addonId} called users.createAddress with address.country that is no ISO 3166-1 alpha-2 code.`);
  }
  return {
    companyName: text("companyName", false),
    name: text("name", true)!,
    line1: text("line1", true)!,
    line2: text("line2", false),
    postalCode: text("postalCode", false),
    city: text("city", true)!,
    region: text("region", false),
    country,
  };
}

/** The purposes and defaults a caller states: at least one purpose, a default only with its purpose. */
function readAddressFlags(addonId: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || ((value as number) & ~PHIS_SITE_ADDRESS_WRITABLE_FLAGS) !== 0) {
    throw new PhisAddonUsersError(`${addonId} called users.createAddress with flags other than Billing, Shipping, DefaultBilling and DefaultShipping; Core keeps the rest.`);
  }
  const flags = value as number;
  if ((flags & (PhisSiteAddressFlags.Billing | PhisSiteAddressFlags.Shipping)) === 0) {
    throw new PhisAddonUsersError(`${addonId} called users.createAddress for an address that is neither a billing nor a shipping address.`);
  }
  if (
    ((flags & PhisSiteAddressFlags.DefaultBilling) !== 0 && (flags & PhisSiteAddressFlags.Billing) === 0)
    || ((flags & PhisSiteAddressFlags.DefaultShipping) !== 0 && (flags & PhisSiteAddressFlags.Shipping) === 0)
  ) {
    throw new PhisAddonUsersError(`${addonId} called users.createAddress with a default for a purpose the address does not have.`);
  }
  return flags;
}
