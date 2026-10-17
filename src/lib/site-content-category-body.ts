import {
  SITE_CONTENT_TERM_LABEL_MAX_LENGTH,
  slugifySiteContentTerm,
} from "@/db/site-content-terms";
import { normalizeNullableInteger, normalizeString } from "@/lib/helpers/request";

/**
 * A category as a create or an update states it: a label, an address and a place in the list.
 *
 * The address may be left out and is then made from the label, the way a person would; one that is given
 * is put through the same rule, so `Reisen & Essen` and `reisen-essen` name one category. Both methods take
 * the whole category, so an update that leaves out the address readdresses it from the label.
 */
export function readSiteContentCategoryBody(body: Record<string, unknown>):
  | { input: { slug: string; label: string; sortOrder: number } }
  | { error: string } {
  const label = normalizeString(body.label);
  if (!label || label.length > SITE_CONTENT_TERM_LABEL_MAX_LENGTH) {
    return { error: `label is required and must be at most ${SITE_CONTENT_TERM_LABEL_MAX_LENGTH} characters.` };
  }
  const slug = slugifySiteContentTerm(normalizeString(body.slug) || label);
  if (!slug) {
    return { error: "A category needs an address with a letter or a digit in it." };
  }
  return { input: { slug, label, sortOrder: normalizeNullableInteger(body.sortOrder) ?? 0 } };
}
