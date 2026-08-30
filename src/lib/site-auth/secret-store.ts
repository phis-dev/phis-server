import "server-only";

import {
  deletePhiServerSecret,
  hasPhiServerSecret,
  hasPhiServerSecrets,
  writePhiServerSecret,
} from "@/db/server-secrets";
import {
  buildPhiAuthSecretReference,
  PHI_AUTH_INSTALLATION_KEY_MAX_LENGTH,
  PHI_AUTH_SECRET_NAME_PREFIX,
} from "@/lib/secrets/reference";
import { readPhiSecretEncryptionKey, resolvePhiSecret } from "@/lib/secrets/resolver";

/**
 * Where an authentication provider's client secret is kept.
 *
 * It used to be kept in `config/phis-runtime.json`, written there at runtime by an admin request. That
 * is a file a second instance does not share and cannot be handed without copying, so every provider an
 * operator configured lived on exactly one host. It is now a row like every other secret, encrypted
 * under the root key that stays in each instance's configuration.
 *
 * Nothing here decrypts. Reading goes through the resolver, so the backend register stays the only
 * thing that knows where a secret actually lives.
 */

const OWNER = { kind: "core" } as const;

export { PHI_AUTH_INSTALLATION_KEY_MAX_LENGTH, PHI_AUTH_SECRET_NAME_PREFIX };

/** The reference builder lives with the reference grammar, because `phis-cli` needs it too. */
export const buildSiteAuthSecretReference = buildPhiAuthSecretReference;

export async function writeSiteAuthSecret(reference: string, value: string, siteId: number) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Authentication provider secret cannot be empty.");
  }
  await writePhiServerSecret({
    reference,
    value: normalized,
    key: readPhiSecretEncryptionKey(),
    siteId,
  });
}

export function deleteSiteAuthSecret(reference: string) {
  return deletePhiServerSecret(reference);
}

/**
 * Whether a provider is configured, which is a different question from what its secret is.
 *
 * The public Auth manifest asks only this, so it never decrypts anything.
 */
export function hasSiteAuthSecret(reference: string | null) {
  return reference ? hasPhiServerSecret(reference) : Promise.resolve(false);
}

export function hasSiteAuthSecrets(references: (string | null)[]) {
  return hasPhiServerSecrets(references.filter((reference): reference is string => Boolean(reference)));
}

export async function readSiteAuthSecret(reference: string | null) {
  if (!reference) {
    return null;
  }
  const value = await resolvePhiSecret(OWNER, reference);
  return value?.trim() || null;
}
