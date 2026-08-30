/**
 * What a secret reference is, and what it deliberately is not.
 *
 * A reference names a secret; it does not say where the secret is kept. That is what lets a deployment
 * move from the database to an external manager without a single caller changing, and it is why the
 * reference -- not the value, and not a storage path -- is what travels through the registry, a Storage
 * Profile row, and a handler context.
 *
 * The shape is readable on purpose. An operator looking at `media_storage_profiles.secret_reference`
 * should be able to tell whose secret it is without joining anything.
 */

export const PHI_SECRET_REFERENCE_MAX_LENGTH = 512;

const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODULE_ID_PATTERN = /^@[^/\s:]+\/[^/\s:]+(?:\/[^/\s:]+)*$/;

export type PhiSecretOwner =
  | { kind: "core" }
  | { kind: "addon"; addonId: string };

export type PhiSecretIdentity = {
  owner: PhiSecretOwner;
  /** The Site this secret belongs to, or null when one secret serves the whole deployment. */
  siteKey: string | null;
  /** What the secret is, within its owner and Site. */
  name: string;
};

function assertSegment(value: string, label: string) {
  if (!SEGMENT_PATTERN.test(value)) {
    throw new Error(`${label} must be lowercase alphanumeric with . _ - and at most 64 characters.`);
  }
}

/**
 * Builds the reference for one secret.
 *
 * ```text
 * core:smtp-password
 * site:acme:core:smtp-password
 * addon:@phis/github:app-private-key
 * site:acme:addon:@phis/storage-s3:secret-access-key
 * ```
 */
export function buildPhiSecretReference(identity: PhiSecretIdentity) {
  const name = identity.name.trim().toLowerCase();
  assertSegment(name, "A secret name");

  const parts: string[] = [];
  if (identity.siteKey != null) {
    const siteKey = identity.siteKey.trim().toLowerCase();
    assertSegment(siteKey, "A Site key");
    parts.push("site", siteKey);
  }
  if (identity.owner.kind === "addon") {
    const addonId = identity.owner.addonId.trim();
    if (!MODULE_ID_PATTERN.test(addonId)) {
      throw new Error(`"${addonId}" is not a namespaced Add-on id.`);
    }
    parts.push("addon", addonId);
  } else {
    parts.push("core");
  }
  parts.push(name);

  const reference = parts.join(":");
  if (reference.length > PHI_SECRET_REFERENCE_MAX_LENGTH) {
    throw new Error("A secret reference must not exceed 512 characters.");
  }
  return reference;
}

/**
 * Reads a reference back, so a caller can be held to its own namespace.
 *
 * A handler resolves references in its own namespace and can neither enumerate nor reach another
 * Add-on's; that check needs the owner, and taking it from the reference means it cannot disagree with
 * the reference the caller actually passed.
 */
export function parsePhiSecretReference(value: string): PhiSecretIdentity | null {
  const parts = value.split(":");
  let index = 0;
  let siteKey: string | null = null;

  if (parts[index] === "site") {
    const key = parts[index + 1];
    if (!key || !SEGMENT_PATTERN.test(key)) return null;
    siteKey = key;
    index += 2;
  }

  let owner: PhiSecretOwner;
  if (parts[index] === "core") {
    owner = { kind: "core" };
    index += 1;
  } else if (parts[index] === "addon") {
    const addonId = parts[index + 1];
    if (!addonId || !MODULE_ID_PATTERN.test(addonId)) return null;
    owner = { kind: "addon", addonId };
    index += 2;
  } else {
    return null;
  }

  const name = parts[index];
  if (name == null || index !== parts.length - 1 || !SEGMENT_PATTERN.test(name)) return null;

  return { owner, siteKey, name };
}

export function isPhiSecretReference(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= PHI_SECRET_REFERENCE_MAX_LENGTH &&
    parsePhiSecretReference(value) !== null;
}

/** Whether a caller owning `owner` may resolve `reference`. */
export function canPhiSecretOwnerResolve(owner: PhiSecretOwner, reference: string) {
  const identity = parsePhiSecretReference(reference);
  if (!identity) return false;
  if (owner.kind === "core") return true;
  return identity.owner.kind === "addon" && identity.owner.addonId === owner.addonId;
}

/**
 * The reference for one authentication provider's client secret.
 *
 * It lives here rather than with the Auth code because `phis-cli` has to build the same one during the
 * import that moves these out of the runtime configuration file, and the CLI cannot load a
 * `server-only` module.
 *
 * The old shape was `site:acme:auth:google`, which this grammar cannot parse at all -- `auth` is
 * neither `core` nor `addon`. The name segment carries it instead, which is what caps the installation
 * key: 64 characters minus the five that `auth.` takes.
 */
export const PHI_AUTH_SECRET_NAME_PREFIX = "auth.";
export const PHI_AUTH_INSTALLATION_KEY_MAX_LENGTH = 59;

const AUTH_INSTALLATION_KEY_PATTERN = new RegExp(
  `^[a-z0-9][a-z0-9-]{0,${PHI_AUTH_INSTALLATION_KEY_MAX_LENGTH - 1}}$`,
);

export function buildPhiAuthSecretReference(siteKey: string, installationKey: string) {
  const normalized = installationKey.trim().toLowerCase();
  if (!AUTH_INSTALLATION_KEY_PATTERN.test(normalized)) {
    throw new Error(
      `"${installationKey}" is not a usable installation key: lowercase alphanumerics and -, at most ` +
      `${PHI_AUTH_INSTALLATION_KEY_MAX_LENGTH} characters.`,
    );
  }
  return buildPhiSecretReference({
    owner: { kind: "core" },
    siteKey: siteKey.trim().toLowerCase(),
    name: `${PHI_AUTH_SECRET_NAME_PREFIX}${normalized}`,
  });
}
