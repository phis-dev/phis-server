/**
 * Internal references, as phi-server reads and writes them.
 *
 * The codec itself lives in `@phis/contracts/references`, because the site UI issues the same values
 * and the two must agree byte for byte -- it stood here and there in two copies until the short form
 * landed. What stays here is the sanitization the server alone performs, because only the server sees
 * a whole untrusted document.
 */

export {
  PHIS_INTERNAL_ASSET_SCHEME,
  PHIS_INTERNAL_PAGE_SCHEME,
  PHI_LINK_TARGET_CONFIG_KEY,
  createPhiAssetUri,
  createPhiPageReference,
  createPhiPageUri,
  createPhiPresetCmsPageId,
  isPhiLinkTargetConfigKey,
  isPhiStorableExternalHref,
  readPhiInternalReference,
  readPhiLinkTarget,
  readPhiPageReference,
  type PhiInternalReference,
  type PhiLinkTarget,
  type PhiPageReference,
  type PhiPageTarget,
  type PhiPageTargetInput,
} from "@phis/contracts/references";

import {
  readPhiInternalReference,
  type PhiInternalReference,
} from "@phis/contracts/references";

const PHI_SCHEME_ENTITY_COLON = /&colon;|&#0*58;|&#x0*3a;/giu;
const PHI_SCHEME_CONTROL_CHARACTERS = /[\u0000-\u0020]+/gu;

/**
 * Collapses the encodings an attacker can use to hide a `phis:` scheme from a naive prefix check:
 * HTML colon entities, repeated percent-encoding, and interleaved control characters.
 * The result is a detection value only; it is never persisted or rendered.
 */
export function normalizePotentialPhiScheme(value: string) {
  let current = value.trim().replace(PHI_SCHEME_ENTITY_COLON, ":");
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current.replace(PHI_SCHEME_CONTROL_CHARACTERS, "");
}

export type PhiReferenceAttribute =
  | { kind: "external" }
  | { kind: "internal"; uri: string; reference: PhiInternalReference }
  | { kind: "invalid" };

/**
 * Classifies one trusted-content `href`/`src` value.
 *
 * Only the canonical literal form is accepted as internal. A value that merely resolves to a `phis:`
 * scheme after decoding is `invalid` and must be dropped, never repaired: authoring emits the
 * canonical form, so an obfuscated variant can only come from a bypass attempt.
 */
export function classifyPhiReferenceAttribute(value: unknown): PhiReferenceAttribute {
  if (typeof value !== "string") return { kind: "invalid" };
  const raw = value.trim();
  const reference = readPhiInternalReference(raw);
  if (reference) return { kind: "internal", uri: raw, reference };
  return normalizePotentialPhiScheme(raw).toLowerCase().startsWith("phis:")
    ? { kind: "invalid" }
    : { kind: "external" };
}

/* `v1s<scope id>` or `v1p<derived Page id>`; the grammar is stated in `@phis/contracts/references`. */
const PHIS_INTERNAL_REFERENCE_IN_TEXT = /phis:(?:asset\/[1-9]\d*|page\/v1[sp][A-Za-z0-9_-]+(?:#[^\s"'<>()[\]]+)?)/gu;

export function collectPhiInternalReferencesFromText(value: string) {
  return [...value.matchAll(PHIS_INTERNAL_REFERENCE_IN_TEXT)].flatMap((match) => {
    const reference = readPhiInternalReference(match[0]);
    return reference ? [{ reference, offset: match.index }] : [];
  });
}
