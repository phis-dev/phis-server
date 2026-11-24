import { PHIS_USER_FIELDS, PhisSiteAddressFlags, type PhisUserField } from "@phis/contracts/users";

/**
 * The stored forms of `users:v1` (SERVER_ADDONS.md, users:v1), shared by the server and the CLI.
 *
 * Fields are kept as bits wherever a row names several of them -- a background grant, an access log
 * entry -- in the order of `PHIS_USER_FIELDS`, so the bit of a field is fixed by the contract's list.
 */

export const PHIS_USER_FIELD_BITS: Readonly<Record<PhisUserField, number>> = Object.freeze(
  Object.fromEntries(PHIS_USER_FIELDS.map((field, index) => [field, 1 << index])) as Record<PhisUserField, number>,
);

/** Every field at once, the mask the grant and the log tables check against. */
export const PHIS_USER_FIELD_ALL_BITS = PHIS_USER_FIELDS.reduce((mask, field) => mask | PHIS_USER_FIELD_BITS[field], 0);

export function isPhisUserField(value: unknown): value is PhisUserField {
  return typeof value === "string" && (PHIS_USER_FIELDS as readonly string[]).includes(value);
}

export function phisUserFieldBitsOf(fields: readonly PhisUserField[]): number {
  return fields.reduce((mask, field) => mask | PHIS_USER_FIELD_BITS[field], 0);
}

/** The fields of a mask, in the contract's order. */
export function phisUserFieldsOf(bits: number): PhisUserField[] {
  return PHIS_USER_FIELDS.filter((field) => (bits & PHIS_USER_FIELD_BITS[field]) !== 0);
}

/** The bits of `PhisSiteAddressFlags`: everything an Add-on is ever shown of an address's flags. */
export const PHIS_SITE_ADDRESS_CONTRACT_FLAGS = Object.values(PhisSiteAddressFlags).reduce((mask, bit) => mask | bit, 0);

/** What a caller states of an address: its purposes and its defaults. Core keeps Superseded and Removed. */
export const PHIS_SITE_ADDRESS_WRITABLE_FLAGS =
  PhisSiteAddressFlags.Billing | PhisSiteAddressFlags.Shipping
  | PhisSiteAddressFlags.DefaultBilling | PhisSiteAddressFlags.DefaultShipping;

export const PHIS_SITE_ADDRESS_DEFAULT_FLAGS = PhisSiteAddressFlags.DefaultBilling | PhisSiteAddressFlags.DefaultShipping;

/** An address that is no longer the person's: replaced by a newer one, or removed by them. */
export const PHIS_SITE_ADDRESS_RETIRED_FLAGS = PhisSiteAddressFlags.Superseded | PhisSiteAddressFlags.Removed;

/**
 * Core's own bit, above the contract's and never answered: the address was handed to an Add-on
 * (`createAddress`, `addresses`, `describe`). Core cannot see an Add-on's records, so this is what tells it
 * that something may point at the address -- removing one that carries it keeps it as `Removed`.
 */
export const PHIS_SITE_ADDRESS_FLAG_HANDED_OUT = 1 << 16;

/** By which road an answer reached an Add-on, as `users_access_log.road` stores it. */
export const PhisUsersAccessRoad = {
  /** A person acting with the Site access `support` or `accounting` (a Site Admin among them). */
  Staff: 1,
  /** The person acting for themself. */
  Self: 2,
  /** Nobody acting: a job, an event handler, a verified hook, on the Site's grant. */
  Background: 3,
  /** A guest's address written by a request with neither, a checkout without an account. */
  Checkout: 4,
} as const;
export type PhisUsersAccessRoadValue = (typeof PhisUsersAccessRoad)[keyof typeof PhisUsersAccessRoad];

/** Which call answered, as `users_access_log.operation` stores it. */
export const PhisUsersAccessOperation = {
  Describe: 1,
  Addresses: 2,
  CreateAddress: 3,
} as const;
export type PhisUsersAccessOperationValue = (typeof PhisUsersAccessOperation)[keyof typeof PhisUsersAccessOperation];

/** The access log's retention when the Site names none, and the bounds `phis site set` takes. */
export const PHIS_USERS_ACCESS_LOG_DEFAULT_DAYS = 90;
export const PHIS_USERS_ACCESS_LOG_MAX_DAYS = 3650;
