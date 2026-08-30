import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for the server secret store.
 *
 * The same shape an enrolled Auth factor already uses -- AES-256-GCM with the ciphertext, the
 * initialization vector, and the authentication tag kept apart -- so a reader who knows one knows both.
 *
 * The key version travels with every record. It is worth nothing until the first rotation and cannot be
 * added afterwards: by then there is ciphertext whose key nobody can name any more.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_PATTERN = /^[a-f0-9]{64}$/i;

export const PHI_SECRET_INITIAL_KEY_VERSION = 1;

export type PhiSecretCipherRecord = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
};

export type PhiSecretEncryptionKey = {
  version: number;
  keyHex: string;
};

export function parsePhiSecretEncryptionKey(raw: string, label: string) {
  const value = raw.trim();
  if (!KEY_PATTERN.test(value)) {
    throw new Error(`${label} must be a 64-character hex string.`);
  }
  return Buffer.from(value, "hex");
}

export function createPhiSecretEncryptionKey() {
  return randomBytes(32).toString("hex");
}

export function encryptPhiSecret(value: string, key: PhiSecretEncryptionKey): PhiSecretCipherRecord {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    ALGORITHM,
    parsePhiSecretEncryptionKey(key.keyHex, "A secret encryption key"),
    iv,
  );
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
    keyVersion: key.version,
  };
}

/**
 * Returns the plaintext, or throws when the record was not produced by this key.
 *
 * GCM authenticates, so a wrong key and a tampered row fail the same way. The caller learns that the
 * secret is unreadable, never a partially decrypted value.
 */
export function decryptPhiSecret(record: PhiSecretCipherRecord, key: PhiSecretEncryptionKey) {
  if (record.keyVersion !== key.version) {
    throw new Error(
      `Secret was encrypted with key version ${record.keyVersion}, and version ${key.version} is configured.`,
    );
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    parsePhiSecretEncryptionKey(key.keyHex, "A secret encryption key"),
    Buffer.from(record.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(record.authTag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
