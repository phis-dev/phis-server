export const PHI_INTERNAL_PAGE_SCHEME = "phi:page/" as const;
export const PHI_INTERNAL_ASSET_SCHEME = "phi:asset/" as const;

export type PhiPageTarget =
  | { kind: "site"; pageScopeId: number }
  | { kind: "module"; ownerModuleId: string; presetKey: string };

export type PhiPageReference = string & { readonly __phiPageReference: unique symbol };

export type PhiInternalReference =
  | { kind: "page"; reference: PhiPageReference; target: PhiPageTarget; fragment: string | null }
  | { kind: "asset"; assetId: number };

const PHI_PAGE_REFERENCE_PREFIX = "v1.";
const PHI_MODULE_ID_PATTERN = /^@[^/]+\/[^/]+(?:\/[^/]+)*$/;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseTarget(value: unknown): PhiPageTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (record.k === "s" && isPositiveInteger(record.i)) {
    return { kind: "site", pageScopeId: record.i };
  }
  if (
    record.k === "m" && typeof record.m === "string" && PHI_MODULE_ID_PATTERN.test(record.m) &&
    typeof record.p === "string" && record.p.trim().length > 0
  ) {
    return { kind: "module", ownerModuleId: record.m, presetKey: record.p };
  }
  return null;
}

export function createPhiPageReference(target: PhiPageTarget): PhiPageReference {
  const payload = target.kind === "site"
    ? { v: 1, k: "s", i: target.pageScopeId }
    : { v: 1, k: "m", m: target.ownerModuleId, p: target.presetKey };
  if (!parseTarget(payload)) throw new Error("Invalid Phi Page target.");
  return `${PHI_PAGE_REFERENCE_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}` as PhiPageReference;
}

export function readPhiPageReference(value: unknown): { reference: PhiPageReference; target: PhiPageTarget } | null {
  if (typeof value !== "string" || !value.startsWith(PHI_PAGE_REFERENCE_PREFIX)) return null;
  try {
    const payload = JSON.parse(Buffer.from(value.slice(PHI_PAGE_REFERENCE_PREFIX.length), "base64url").toString("utf8"));
    const target = parseTarget(payload);
    return target ? { reference: value as PhiPageReference, target } : null;
  } catch {
    return null;
  }
}

export function readPhiInternalReference(value: unknown): PhiInternalReference | null {
  if (typeof value !== "string") return null;
  if (value.startsWith(PHI_INTERNAL_ASSET_SCHEME)) {
    const rawId = value.slice(PHI_INTERNAL_ASSET_SCHEME.length);
    return /^[1-9]\d*$/u.test(rawId) && Number.isSafeInteger(Number(rawId))
      ? { kind: "asset", assetId: Number(rawId) }
      : null;
  }
  if (!value.startsWith(PHI_INTERNAL_PAGE_SCHEME)) return null;
  const [rawReference, ...fragmentParts] = value.slice(PHI_INTERNAL_PAGE_SCHEME.length).split("#");
  const parsed = readPhiPageReference(rawReference);
  if (!parsed) return null;
  try {
    return {
      kind: "page",
      ...parsed,
      fragment: fragmentParts.length > 0 ? decodeURIComponent(fragmentParts.join("#")) : null,
    };
  } catch {
    return null;
  }
}

const PHI_SCHEME_ENTITY_COLON = /&colon;|&#0*58;|&#x0*3a;/giu;
const PHI_SCHEME_CONTROL_CHARACTERS = /[\u0000-\u0020]+/gu;

/**
 * Collapses the encodings an attacker can use to hide a `phi:` scheme from a naive prefix check:
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
 * Only the canonical literal form is accepted as internal. A value that merely resolves to a `phi:`
 * scheme after decoding is `invalid` and must be dropped, never repaired: authoring emits the
 * canonical form, so an obfuscated variant can only come from a bypass attempt.
 */
export function classifyPhiReferenceAttribute(value: unknown): PhiReferenceAttribute {
  if (typeof value !== "string") return { kind: "invalid" };
  const raw = value.trim();
  const reference = readPhiInternalReference(raw);
  if (reference) return { kind: "internal", uri: raw, reference };
  return normalizePotentialPhiScheme(raw).toLowerCase().startsWith("phi:")
    ? { kind: "invalid" }
    : { kind: "external" };
}

const PHI_INTERNAL_REFERENCE_IN_TEXT = /phi:(?:asset\/[1-9]\d*|page\/v1\.[A-Za-z0-9_-]+(?:#[^\s"'<>()[\]]+)?)/gu;

export function collectPhiInternalReferencesFromText(value: string) {
  return [...value.matchAll(PHI_INTERNAL_REFERENCE_IN_TEXT)].flatMap((match) => {
    const reference = readPhiInternalReference(match[0]);
    return reference ? [{ reference, offset: match.index }] : [];
  });
}

export function createPhiPageUri(reference: PhiPageReference, fragment?: string | null) {
  if (!readPhiPageReference(reference)) throw new Error("Invalid Phi Page reference.");
  const normalizedFragment = fragment?.replace(/^#/u, "").trim();
  return `${PHI_INTERNAL_PAGE_SCHEME}${reference}${normalizedFragment ? `#${encodeURIComponent(normalizedFragment)}` : ""}`;
}

export function createPhiAssetUri(assetId: number) {
  if (!isPositiveInteger(assetId)) throw new Error("Phi Asset ids must be positive integers.");
  return `${PHI_INTERNAL_ASSET_SCHEME}${assetId}`;
}
