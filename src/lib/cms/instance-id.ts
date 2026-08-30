const PHI_CMS_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const PHI_CMS_BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const PHI_CMS_INSTANCE_ID_VERSION = 1;
const PHI_CMS_INSTANCE_ID_ORIGIN_PRESET = 1;
const PHI_CMS_INSTANCE_ID_ORIGIN_DRAFT = 2;
const PHI_CMS_INSTANCE_ID_DOMAIN_AREA = 1;
const PHI_CMS_INSTANCE_ID_DOMAIN_PAGE = 2;
const PHI_CMS_INSTANCE_ID_DOMAIN_NAVIGATION = 3;

declare const PHI_CMS_INSTANCE_ID_BRAND: unique symbol;

export type PhiCmsInstanceId = string & {
  readonly [PHI_CMS_INSTANCE_ID_BRAND]: "PhiCmsInstanceId";
};

export type PhiCmsInstanceDomain = "area" | "page" | "navigation";
export type PhiCmsInstanceOrigin = "preset" | "draft";

export type PhiCmsPresetInstanceIdentity = {
  domain: PhiCmsInstanceDomain;
  ownerModuleId: string;
  presetKey: string;
  nodeKey: string;
};

export type PhiCmsInstanceIdDescriptor =
  | { version: 1; origin: "preset"; domain: PhiCmsInstanceDomain }
  | {
      version: 1;
      origin: "draft";
      domain: PhiCmsInstanceDomain;
      draftRevisionId: number;
      sequence: number;
    };

function readUnsignedBigEndian(bytes: Uint8Array, offset: number, length: number) {
  let value = 0;
  for (let index = offset; index < offset + length; index += 1) {
    value = (value * 256) + bytes[index]!;
  }
  return value;
}

function readDomain(value: number): PhiCmsInstanceDomain | null {
  if (value === PHI_CMS_INSTANCE_ID_DOMAIN_AREA) return "area";
  if (value === PHI_CMS_INSTANCE_ID_DOMAIN_PAGE) return "page";
  if (value === PHI_CMS_INSTANCE_ID_DOMAIN_NAVIGATION) return "navigation";
  return null;
}

function decodePhiCmsInstanceId(value: string) {
  if (!PHI_CMS_INSTANCE_ID_PATTERN.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(12);
  for (let index = 0; index < value.length; index += 4) {
    const first = PHI_CMS_BASE64URL_ALPHABET.indexOf(value[index]!);
    const second = PHI_CMS_BASE64URL_ALPHABET.indexOf(value[index + 1]!);
    const third = PHI_CMS_BASE64URL_ALPHABET.indexOf(value[index + 2]!);
    const fourth = PHI_CMS_BASE64URL_ALPHABET.indexOf(value[index + 3]!);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      return null;
    }
    const byteIndex = (index / 4) * 3;
    bytes[byteIndex] = (first << 2) | (second >>> 4);
    bytes[byteIndex + 1] = ((second & 0x0f) << 4) | (third >>> 2);
    bytes[byteIndex + 2] = ((third & 0x03) << 6) | fourth;
  }
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    output += PHI_CMS_BASE64URL_ALPHABET[first >>> 2];
    output += PHI_CMS_BASE64URL_ALPHABET[((first & 0x03) << 4) | (second >>> 4)];
    output += PHI_CMS_BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third >>> 6)];
    output += PHI_CMS_BASE64URL_ALPHABET[third & 0x3f];
  }
  return output;
}

function readDomainCode(domain: PhiCmsInstanceDomain) {
  if (domain === "area") return PHI_CMS_INSTANCE_ID_DOMAIN_AREA;
  if (domain === "page") return PHI_CMS_INSTANCE_ID_DOMAIN_PAGE;
  return PHI_CMS_INSTANCE_ID_DOMAIN_NAVIGATION;
}

function normalizeIdentityPart(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function hashPresetIdentity(value: string) {
  const bytes = new TextEncoder().encode(value);
  const state = new Uint32Array([0x811c9dc5, 0x9e3779b9, 0x85ebca6b]);
  const primes = [0x01000193, 0x27d4eb2d, 0x165667b1] as const;
  for (const byte of bytes) {
    for (let index = 0; index < state.length; index += 1) {
      state[index] = Math.imul(state[index]! ^ (byte + index * 17), primes[index]!) >>> 0;
      state[index] ^= state[index]! >>> 13;
    }
  }
  const result = new Uint8Array(10);
  for (let index = 0; index < result.length; index += 1) {
    const lane = index % state.length;
    state[lane] = Math.imul(state[lane]! ^ (index + bytes.length), primes[lane]!) >>> 0;
    result[index] = state[lane]! >>> ((index % 4) * 8);
  }
  return result;
}

export function createPhiPresetCmsInstanceId({
  domain,
  ownerModuleId,
  presetKey,
  nodeKey,
}: PhiCmsPresetInstanceIdentity): PhiCmsInstanceId {
  const identity = [
    `v${PHI_CMS_INSTANCE_ID_VERSION}`,
    domain,
    normalizeIdentityPart(ownerModuleId, "Preset owner module id"),
    normalizeIdentityPart(presetKey, "Preset key"),
    normalizeIdentityPart(nodeKey, "Preset node key"),
  ].join("\u001f");
  const bytes = new Uint8Array(12);
  bytes[0] = (PHI_CMS_INSTANCE_ID_VERSION << 4) | PHI_CMS_INSTANCE_ID_ORIGIN_PRESET;
  bytes[1] = readDomainCode(domain);
  bytes.set(hashPresetIdentity(identity), 2);
  return encodeBase64Url(bytes) as PhiCmsInstanceId;
}

export function readPhiCmsInstanceIdDescriptor(value: unknown): PhiCmsInstanceIdDescriptor | null {
  if (typeof value !== "string") {
    return null;
  }
  const bytes = decodePhiCmsInstanceId(value);
  if (!bytes) {
    return null;
  }
  const version = bytes[0]! >>> 4;
  const origin = bytes[0]! & 0x0f;
  const domain = readDomain(bytes[1]!);
  if (version !== PHI_CMS_INSTANCE_ID_VERSION || !domain) {
    return null;
  }
  if (origin === PHI_CMS_INSTANCE_ID_ORIGIN_PRESET) {
    return { version: 1, origin: "preset", domain };
  }
  if (origin !== PHI_CMS_INSTANCE_ID_ORIGIN_DRAFT) {
    return null;
  }
  const draftRevisionId = readUnsignedBigEndian(bytes, 2, 6);
  const sequence = readUnsignedBigEndian(bytes, 8, 4);
  return draftRevisionId > 0 && sequence > 0
    ? { version: 1, origin: "draft", domain, draftRevisionId, sequence }
    : null;
}

export function isPhiCmsInstanceId(value: unknown): value is PhiCmsInstanceId {
  return readPhiCmsInstanceIdDescriptor(value) !== null;
}

export function readPhiCmsInstanceId(value: unknown): PhiCmsInstanceId | null {
  return isPhiCmsInstanceId(value) ? value : null;
}
