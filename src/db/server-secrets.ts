import "server-only";

import { getPool } from "@/lib/db";
import type { PhiSecretEncryptionKey } from "@/lib/secrets/crypto";
import {
  deletePhisSecretWithDb,
  hasPhisSecretsWithDb,
  readPhisSecretWithDb,
  writePhisSecretWithDb,
} from "./server-secrets-store.mts";

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

export function hasPhisSecrets(references: string[]) {
  return hasPhisSecretsWithDb(getPool(), references);
}

export function deletePhisSecret(reference: string) {
  return deletePhisSecretWithDb(getPool(), reference);
}
