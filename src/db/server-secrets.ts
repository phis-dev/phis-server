import "server-only";

import { getPool } from "@/lib/db";
import type { PhiSecretEncryptionKey } from "@/lib/secrets/crypto";
import {
  deletePhiServerSecretWithDb,
  hasPhiServerSecretWithDb,
  hasPhiServerSecretsWithDb,
  listPhiServerSecretsWithDb,
  readPhiServerSecretWithDb,
  writePhiServerSecretWithDb,
  type PhiServerSecretRecord,
} from "./server-secrets-store.mts";

export type { PhiServerSecretRecord };
export {
  deletePhiServerSecretWithDb,
  hasPhiServerSecretWithDb,
  hasPhiServerSecretsWithDb,
  listPhiServerSecretsWithDb,
  readPhiServerSecretWithDb,
  writePhiServerSecretWithDb,
};

export function writePhiServerSecret(input: {
  reference: string;
  value: string;
  key: PhiSecretEncryptionKey;
  siteId?: number | null;
}) {
  return writePhiServerSecretWithDb(getPool(), input);
}

export function readPhiServerSecret(reference: string, key: PhiSecretEncryptionKey) {
  return readPhiServerSecretWithDb(getPool(), reference, key);
}

export function hasPhiServerSecret(reference: string) {
  return hasPhiServerSecretWithDb(getPool(), reference);
}

export function hasPhiServerSecrets(references: string[]) {
  return hasPhiServerSecretsWithDb(getPool(), references);
}

export function deletePhiServerSecret(reference: string) {
  return deletePhiServerSecretWithDb(getPool(), reference);
}

export function listPhiServerSecrets(filter?: { siteId?: number | null; addonId?: string | null }) {
  return listPhiServerSecretsWithDb(getPool(), filter);
}
