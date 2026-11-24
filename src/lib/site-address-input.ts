import { PhisSiteAddressFlags, type PhisSiteAddressInput } from "@phis/contracts/users";

import { PHIS_SITE_ADDRESS_WRITABLE_FLAGS } from "@/lib/constants/users";

/**
 * An address and its flags as a caller writes them, held to what `phis.site_addresses` stores: shared by
 * `users:v1` `createAddress` and the account routes (`/api/site/account/addresses`), so an Add-on and a
 * person are held to one rule. Refusals are `PhisSiteAddressInputError`, whose message names the part.
 */

export class PhisSiteAddressInputError extends Error {}

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

/** The text of an address as Core stores it: trimmed, empty optional parts as null, held to the columns. */
export function readPhisSiteAddressInput(value: unknown): PhisSiteAddressInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PhisSiteAddressInputError("no address was given.");
  }
  const record = value as Record<string, unknown>;
  const text = (key: keyof typeof ADDRESS_TEXT_LIMITS, required: boolean): string | null => {
    const raw = record[key];
    if (raw === undefined || raw === null) {
      if (required) throw new PhisSiteAddressInputError(`address.${key} is missing.`);
      return null;
    }
    if (typeof raw !== "string" || CONTROL_CHARACTERS.test(raw)) {
      throw new PhisSiteAddressInputError(`address.${key} is no line of text.`);
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      if (required) throw new PhisSiteAddressInputError(`address.${key} is empty.`);
      return null;
    }
    if (trimmed.length > ADDRESS_TEXT_LIMITS[key]) {
      throw new PhisSiteAddressInputError(`address.${key} is longer than ${ADDRESS_TEXT_LIMITS[key]} characters.`);
    }
    return trimmed;
  };
  const country = typeof record.country === "string" ? record.country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/u.test(country)) {
    throw new PhisSiteAddressInputError("address.country is no ISO 3166-1 alpha-2 code.");
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
export function readPhisSiteAddressFlags(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || ((value as number) & ~PHIS_SITE_ADDRESS_WRITABLE_FLAGS) !== 0) {
    throw new PhisSiteAddressInputError("flags other than Billing, Shipping, DefaultBilling and DefaultShipping were given; Core keeps the rest.");
  }
  const flags = value as number;
  if ((flags & (PhisSiteAddressFlags.Billing | PhisSiteAddressFlags.Shipping)) === 0) {
    throw new PhisSiteAddressInputError("the address is neither a billing nor a shipping address.");
  }
  if (
    ((flags & PhisSiteAddressFlags.DefaultBilling) !== 0 && (flags & PhisSiteAddressFlags.Billing) === 0)
    || ((flags & PhisSiteAddressFlags.DefaultShipping) !== 0 && (flags & PhisSiteAddressFlags.Shipping) === 0)
  ) {
    throw new PhisSiteAddressInputError("a default was given for a purpose the address does not have.");
  }
  return flags;
}
