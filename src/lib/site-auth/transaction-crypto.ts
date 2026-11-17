import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getPhisConfigSync } from "@/lib/config";

const ALGORITHM = "aes-256-gcm";

function parseKey(raw: string) {
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    throw new Error("auth.transactionEncryptionKey must be a 64-character hex string.");
  }
  return Buffer.from(raw, "hex");
}

function readConfiguredKey() {
  const raw = getPhisConfigSync().auth?.transactionEncryptionKey?.trim() ?? "";
  if (!raw) {
    throw new Error("Missing auth.transactionEncryptionKey in config/phis-runtime.json.");
  }
  return parseKey(raw);
}

export function encryptAuthTransactionPayloadWithKey(
  payload: Record<string, unknown>,
  keyHex: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, parseKey(keyHex), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
  };
}

export function decryptAuthTransactionPayloadWithKey(
  input: { ciphertext: Buffer; iv: Buffer; authTag: Buffer },
  keyHex: string,
) {
  const decipher = createDecipheriv(ALGORITHM, parseKey(keyHex), input.iv);
  decipher.setAuthTag(input.authTag);
  const plaintext = Buffer.concat([
    decipher.update(input.ciphertext),
    decipher.final(),
  ]).toString("utf8");
  const value: unknown = JSON.parse(plaintext);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Auth transaction payload.");
  }
  return value as Record<string, unknown>;
}

export function encryptAuthTransactionPayload(payload: Record<string, unknown>) {
  const key = readConfiguredKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
  };
}

export function decryptAuthTransactionPayload(input: {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}) {
  const keyHex = readConfiguredKey().toString("hex");
  return decryptAuthTransactionPayloadWithKey(input, keyHex);
}
