import type { PhisProductDraft, PhisProductId, PhisProductSale } from "@phis/contracts/addon";
import { PHIS_PRODUCT_DESCRIPTION_MAX, PHIS_PRODUCT_GALLERY_MAX, readPhisProductLink, type PhisProductLink } from "@phis/contracts/products";

import { resolvePhiLocaleBase, resolvePhiLocaleCapability } from "../locale.ts";

/**
 * What a product's draft has to be, judged without the database.
 *
 * Pure and not `server-only`: the capability checks a supplier's draft with it, the manifest validation
 * checks a declared product, and the CLI checks the manifest products it registers at a Site.
 */

const PRODUCT_KEY_PATTERN = /^[a-z][a-z0-9.-]*$/;
const PRODUCT_ID_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:[a-z][a-z0-9.-]*$/;
export const PHIS_PRODUCT_KEY_MAX_LENGTH = 96;
export const PHIS_PRODUCT_TYPE_MAX_LENGTH = 64;
export const PHIS_PRODUCT_TITLE_MAX_LENGTH = 200;
export const PHIS_PRODUCT_SUMMARY_MAX_LENGTH = 1000;
/** Markdown, so line breaks and tabs are its own; `phis.products.description` checks the same length. */
export const PHIS_PRODUCT_DESCRIPTION_MAX_LENGTH = PHIS_PRODUCT_DESCRIPTION_MAX;
export const PHIS_PRODUCT_GALLERY_MAX_PICTURES = PHIS_PRODUCT_GALLERY_MAX;
export const PHIS_PRODUCT_PUBLISHER_MAX_LENGTH = 255;
export const PHIS_PRODUCT_REFERRAL_URL_MAX_LENGTH = 2000;
export const PHIS_PRODUCT_PARTS_MAX = 100;
const SALES: readonly PhisProductSale[] = ["own", "referral", "payout"];

export class PhisProductDraftError extends Error {}

/** Whether a string is a product id by its grammar; whether anybody registered it is another question. */
export function isPhisProductId(value: unknown): value is PhisProductId {
  return typeof value === "string" && value.length <= 255 + 1 + PHIS_PRODUCT_KEY_MAX_LENGTH && PRODUCT_ID_PATTERN.test(value)
    && value.slice(value.lastIndexOf(":") + 1).length <= PHIS_PRODUCT_KEY_MAX_LENGTH;
}

export function isPhisProductKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= PHIS_PRODUCT_KEY_MAX_LENGTH && PRODUCT_KEY_PATTERN.test(value);
}

/** The supplier half and the key half of a product id. */
export function splitPhisProductId(id: PhisProductId): { supplier: string; key: string } {
  const separator = id.lastIndexOf(":");
  return { supplier: id.slice(0, separator), key: id.slice(separator + 1) };
}

export type PhisNormalizedProductDraft = {
  key: string;
  publisher: string | null;
  type: string;
  title: string;
  summary: string;
  description: string;
  /** The button: a target `readPhisProductLink` took and the label trimmed, '' for none; null for no button. */
  link: PhisProductLink | null;
  /**
   * The language the texts are written in, in the catalogue's spelling; null for the Site's. As the draft
   * states it -- `phisProductSourceLocaleAtSite` turns the Site's own language into null before a register.
   */
  sourceLocale: string | null;
  imageAssetId: number | null;
  iconAssetId: number | null;
  /** First to last, none twice. */
  gallery: number[];
  counted: boolean;
  sale: PhisProductSale;
  referralUrl: string | null;
  free: boolean;
  accountRequired: boolean;
  parts: PhisProductId[];
};

function text(value: unknown, name: string, max: number, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PhisProductDraftError(`${name} must be ${allowEmpty ? "at most" : "1 to"} ${max} characters without control characters.`);
  }
  return value;
}

/**
 * A product's language as Core keeps it: null where it is the Site's source language -- also where a
 * supplier names it, which is how a product read back (`sourceLocale` always stated) and written again
 * stays the Site's -- else the language in the catalogue's spelling.
 */
export function phisProductSourceLocaleAtSite(sourceLocale: string | null, siteSourceLocale: string): string | null {
  return sourceLocale === null || resolvePhiLocaleBase(sourceLocale) === resolvePhiLocaleBase(siteSourceLocale) ? null : sourceLocale;
}

/** A stated language, in the catalogue's spelling, or the rule it breaks; absent and null are the Site's. */
function readSourceLocale(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const capability = typeof value === "string" ? resolvePhiLocaleCapability(value) : null;
  if (!capability) throw new PhisProductDraftError("sourceLocale is a locale key Core knows, such as fr or pt-BR, or null for the Site's language.");
  return capability.locale;
}

/**
 * The draft with its defaults filled in, or the first rule it breaks.
 *
 * The rules that need other rows -- that a part exists, that nothing forms a circle, that `counted` is
 * still free to change -- are the database layer's.
 */
export function normalizePhisProductDraft(draft: PhisProductDraft, ownId?: PhisProductId): PhisNormalizedProductDraft {
  if (typeof draft !== "object" || draft === null) throw new PhisProductDraftError("A product draft is an object.");
  if (!isPhisProductKey(draft.key)) {
    throw new PhisProductDraftError(`A product key matches ^[a-z][a-z0-9.-]*$ and has at most ${PHIS_PRODUCT_KEY_MAX_LENGTH} characters.`);
  }
  const publisher = draft.publisher === undefined || draft.publisher === null
    ? null
    : text(draft.publisher, "publisher", PHIS_PRODUCT_PUBLISHER_MAX_LENGTH);
  const sale = draft.sale ?? "own";
  if (!SALES.includes(sale)) throw new PhisProductDraftError("sale is own, referral or payout.");
  let referralUrl: string | null = null;
  if (sale === "referral") {
    const url = text(draft.referralUrl, "referralUrl", PHIS_PRODUCT_REFERRAL_URL_MAX_LENGTH);
    let parsed: URL | null = null;
    try { parsed = new URL(url); } catch { /* refused below */ }
    if (!parsed || parsed.protocol !== "https:" || !parsed.hostname) {
      throw new PhisProductDraftError("A product sold by referral names the publisher's address as an https URL in referralUrl.");
    }
    referralUrl = url;
  }
  const parts = draft.parts === undefined ? [] : draft.parts;
  if (!Array.isArray(parts) || parts.length > PHIS_PRODUCT_PARTS_MAX || !parts.every(isPhisProductId)) {
    throw new PhisProductDraftError(`parts is a list of at most ${PHIS_PRODUCT_PARTS_MAX} product ids.`);
  }
  if (new Set(parts).size !== parts.length) throw new PhisProductDraftError("parts names a product twice.");
  if (ownId && parts.includes(ownId)) throw new PhisProductDraftError("A product is not a part of itself.");
  const counted = draft.counted === true;
  if (draft.counted !== undefined && typeof draft.counted !== "boolean") throw new PhisProductDraftError("counted is a boolean.");
  if (draft.accountRequired !== undefined && typeof draft.accountRequired !== "boolean") throw new PhisProductDraftError("accountRequired is a boolean.");
  if (draft.free !== undefined && typeof draft.free !== "boolean") throw new PhisProductDraftError("free is a boolean.");
  if (counted && parts.length > 0) throw new PhisProductDraftError("A bundle is not counted.");
  const imageAssetId = draft.imageAssetId ?? null;
  if (imageAssetId !== null && (!Number.isInteger(imageAssetId) || imageAssetId <= 0)) {
    throw new PhisProductDraftError("imageAssetId is the id of an Asset of the Site, or null.");
  }
  const iconAssetId = draft.iconAssetId ?? null;
  if (iconAssetId !== null && (!Number.isInteger(iconAssetId) || iconAssetId <= 0)) {
    throw new PhisProductDraftError("iconAssetId is the id of an Asset of the Site, or null.");
  }
  const description = draft.description === undefined ? "" : draft.description;
  if (typeof description !== "string" || description.length > PHIS_PRODUCT_DESCRIPTION_MAX_LENGTH
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(description)) {
    throw new PhisProductDraftError(
      `description must be Markdown of at most ${PHIS_PRODUCT_DESCRIPTION_MAX_LENGTH} characters without control characters other than tabs and line breaks.`,
    );
  }
  const { link, issue: linkIssue } = readPhisProductLink(draft.link);
  if (linkIssue !== null) throw new PhisProductDraftError(linkIssue);
  if (link?.label && /[\u0000-\u001f\u007f]/u.test(link.label)) {
    throw new PhisProductDraftError("`link.label` must be without control characters.");
  }
  const gallery = draft.gallery === undefined ? [] : draft.gallery;
  if (!Array.isArray(gallery) || gallery.length > PHIS_PRODUCT_GALLERY_MAX_PICTURES
    || !gallery.every((id) => Number.isInteger(id) && id > 0 && id <= 2_147_483_647)) {
    throw new PhisProductDraftError(`gallery is a list of at most ${PHIS_PRODUCT_GALLERY_MAX_PICTURES} ids of Assets of the Site.`);
  }
  if (new Set(gallery).size !== gallery.length) throw new PhisProductDraftError("gallery names an Asset twice.");
  return {
    key: draft.key,
    publisher,
    type: text(draft.type, "type", PHIS_PRODUCT_TYPE_MAX_LENGTH),
    title: text(draft.title, "title", PHIS_PRODUCT_TITLE_MAX_LENGTH),
    summary: text(draft.summary, "summary", PHIS_PRODUCT_SUMMARY_MAX_LENGTH, true),
    description,
    link: link ? { target: link.target, label: link.label ?? "" } : null,
    sourceLocale: readSourceLocale(draft.sourceLocale),
    imageAssetId,
    iconAssetId,
    gallery: [...gallery],
    counted,
    sale,
    referralUrl,
    free: draft.free === true,
    accountRequired: draft.accountRequired === true,
    parts: [...parts] as PhisProductId[],
  };
}
