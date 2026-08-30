import { describe, expect, it } from "vitest";

import {
  decryptAuthTransactionPayloadWithKey,
  encryptAuthTransactionPayloadWithKey,
} from "./transaction-crypto";

describe("Auth transaction encryption", () => {
  const key = "a1".repeat(32);

  it("round-trips provider state without persisting plaintext", () => {
    const payload = {
      state: "state-value",
      nonce: "nonce-value",
      pkceVerifier: "pkce-value",
      callbackUrl: "https://example.test/api/auth/providers/google/callback",
    };
    const encrypted = encryptAuthTransactionPayloadWithKey(payload, key);

    expect(encrypted.ciphertextHex).not.toContain("state-value");
    expect(decryptAuthTransactionPayloadWithKey(encrypted, key)).toEqual(payload);
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptAuthTransactionPayloadWithKey({ state: "state-value" }, key);
    const firstByte = encrypted.ciphertextHex.slice(0, 2) === "00" ? "01" : "00";

    expect(() => decryptAuthTransactionPayloadWithKey({
      ...encrypted,
      ciphertextHex: firstByte + encrypted.ciphertextHex.slice(2),
    }, key)).toThrow();
  });

  it("rejects invalid operator keys", () => {
    expect(() => encryptAuthTransactionPayloadWithKey({}, "not-a-key")).toThrow(
      "auth.transactionEncryptionKey",
    );
  });
});
