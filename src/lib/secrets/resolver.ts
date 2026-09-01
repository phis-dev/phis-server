import "server-only";

import { getPhiServerConfigSync } from "@/lib/config";
import { readPhiServerSecret } from "@/db/server-secrets";
import {
  PHI_SECRET_INITIAL_KEY_VERSION,
  type PhiSecretEncryptionKey,
} from "@/lib/secrets/crypto";
import {
  canPhiSecretOwnerResolve,
  parsePhiSecretReference,
  type PhiSecretOwner,
} from "@/lib/secrets/reference";

/**
 * The one place a secret turns back into a value.
 *
 * Resolution goes through a register rather than a direct read, because a reference does not state
 * where its secret is kept. Today one backend answers -- the encrypted database store -- and a
 * deployment that later keeps secrets in an external manager registers a second one without any caller
 * changing.
 *
 * A caller states who it is. An Add-on resolves references in its own namespace and can neither
 * enumerate nor reach another Add-on's; taking the owner from the reference itself would make that
 * check agree with the caller by construction.
 */

export type PhiSecretBackend = {
  id: string;
  resolve: (reference: string) => Promise<string | null>;
};

export const PHI_SECRET_DATABASE_BACKEND_ID = "@phis/server/secrets/database";

export class PhiMissingSecretEncryptionKeyError extends Error {
  constructor() {
    super(
      "Missing secrets.encryptionKey in the runtime configuration. Every stored secret is unreadable " +
      "without it, so this instance must not report ready.",
    );
    this.name = "PhiMissingSecretEncryptionKeyError";
  }
}

export function readPhiSecretEncryptionKey(): PhiSecretEncryptionKey {
  const config = getPhiServerConfigSync().secrets;
  const keyHex = config?.encryptionKey?.trim() ?? "";
  if (!keyHex) {
    throw new PhiMissingSecretEncryptionKeyError();
  }
  return {
    keyHex,
    version: config?.encryptionKeyVersion ?? PHI_SECRET_INITIAL_KEY_VERSION,
  };
}

/**
 * Whether this instance can read the secrets it holds.
 *
 * Section 17 makes readiness a reported fact, not an assumption: an instance without its root key
 * answers no requests rather than failing every one that needs a secret.
 */
export function isPhiSecretStoreReadable() {
  try {
    readPhiSecretEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

const databaseBackend: PhiSecretBackend = {
  id: PHI_SECRET_DATABASE_BACKEND_ID,
  resolve: (reference) => readPhiServerSecret(reference, readPhiSecretEncryptionKey()),
};

const backends = new Map<string, PhiSecretBackend>([[databaseBackend.id, databaseBackend]]);
let activeBackendId = databaseBackend.id;

export function registerPhiSecretBackend(backend: PhiSecretBackend) {
  if (backends.has(backend.id)) {
    throw new Error(`Secret backend "${backend.id}" is already registered.`);
  }
  backends.set(backend.id, backend);
}

export function usePhiSecretBackend(backendId: string) {
  if (!backends.has(backendId)) {
    throw new Error(`Secret backend "${backendId}" is not registered.`);
  }
  activeBackendId = backendId;
}

export function getPhiSecretBackendId() {
  return activeBackendId;
}

/**
 * Resolves a reference for a stated owner.
 *
 * Returns null for a secret that is not configured, and throws for one that exists but cannot be read.
 * The two call for different operator action, and a resolver that collapsed them would let a key that
 * was rotated away look like configuration nobody had done yet.
 */
export async function resolvePhiSecret(owner: PhiSecretOwner, reference: string) {
  const identity = parsePhiSecretReference(reference);
  if (!identity) {
    throw new Error(`"${reference}" is not a valid secret reference.`);
  }
  if (!canPhiSecretOwnerResolve(owner, reference)) {
    throw new Error(
      `${owner.kind === "addon" ? owner.addonId : "Core"} may not resolve ${reference}.`,
    );
  }
  return backends.get(activeBackendId)!.resolve(reference);
}
