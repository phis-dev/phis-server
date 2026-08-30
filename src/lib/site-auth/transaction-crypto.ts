import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getPhiServerConfigSync } from "@/lib/config";

const ALGORITHM = "aes-256-gcm";

function parseKey(raw: string) {
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    throw new Error("auth.transactionEncryptionKey must be a 64-character hex string.");
  }
  return Buffer.from(raw, "hex");
}

function readConfiguredKey() {
  const raw = getPhiServerConfigSync().auth?.transactionEncryptionKey?.trim() ?? "";
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
    ciphertextHex: ciphertext.toString("hex"),
    ivHex: iv.toString("hex"),
    authTagHex: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptAuthTransactionPayloadWithKey(
  input: { ciphertextHex: string; ivHex: string; authTagHex: string },
  keyHex: string,
) {
  const decipher = createDecipheriv(ALGORITHM, parseKey(keyHex), Buffer.from(input.ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(input.authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(input.ciphertextHex, "hex")),
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
    ciphertextHex: ciphertext.toString("hex"),
    ivHex: iv.toString("hex"),
    authTagHex: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptAuthTransactionPayload(input: {
  ciphertextHex: string;
  ivHex: string;
  authTagHex: string;
}) {
  const keyHex = readConfiguredKey().toString("hex");
  return decryptAuthTransactionPayloadWithKey(input, keyHex);
}
