import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getPhisConfigSync } from "@/lib/config";

const ALGORITHM = "aes-256-gcm";

function readKey() {
  const raw = getPhisConfigSync().registration?.intentEncryptionKey?.trim() ?? "";

  if (!raw) {
    throw new Error(
      "Missing registration.intentEncryptionKey in config/phis-runtime.json.",
    );
  }

  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    throw new Error(
      "REGISTRATION_INTENT_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).",
    );
  }

  return Buffer.from(raw, "hex");
}

export function encryptRegistrationPassword(password: string) {
  const key = readKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    iv,
    ciphertext,
    authTag,
  };
}

export function decryptRegistrationPassword(input: {
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}) {
  const key = readKey();
  const decipher = createDecipheriv(ALGORITHM, key, input.iv);
  decipher.setAuthTag(input.authTag);

  const plaintext = Buffer.concat([
    decipher.update(input.ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}
