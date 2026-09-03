import "server-only";

import { getPool } from "@/lib/db";
import type { PhiSecretEncryptionKey } from "@/lib/secrets/crypto";
import {
  deletePhisSecretWithDb,
  hasPhisSecretWithDb,
  hasPhisSecretsWithDb,
  listPhisSecretsWithDb,
  readPhisSecretWithDb,
  writePhisSecretWithDb,
  type PhisSecretRecord,
} from "./server-secrets-store.mts";

export type { PhisSecretRecord };
export {
  deletePhisSecretWithDb,
  hasPhisSecretWithDb,
  hasPhisSecretsWithDb,
  listPhisSecretsWithDb,
  readPhisSecretWithDb,
  writePhisSecretWithDb,
};

export function writePhisSecret(input: {
  reference: string;
  value: string;
  key: PhiSecretEncryptionKey;
  siteId?: number | null;
}) {
  return writePhisSecretWithDb(getPool(), input);
}

export function readPhisSecret(reference: string, key: PhiSecretEncryptionKey) {
  return readPhisSecretWithDb(getPool(), reference, key);
}

export function hasPhisSecret(reference: string) {
  return hasPhisSecretWithDb(getPool(), reference);
}

export function hasPhisSecrets(references: string[]) {
  return hasPhisSecretsWithDb(getPool(), references);
}

export function deletePhisSecret(reference: string) {
  return deletePhisSecretWithDb(getPool(), reference);
}

export function listPhisSecrets(filter?: { siteId?: number | null; addonId?: string | null }) {
  return listPhisSecretsWithDb(getPool(), filter);
}
