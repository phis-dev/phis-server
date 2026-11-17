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

    expect(encrypted.ciphertext.toString("utf8")).not.toContain("state-value");
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(decryptAuthTransactionPayloadWithKey(encrypted, key)).toEqual(payload);
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptAuthTransactionPayloadWithKey({ state: "state-value" }, key);
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;

    expect(() => decryptAuthTransactionPayloadWithKey({
      ...encrypted,
      ciphertext: tampered,
    }, key)).toThrow();
  });

  it("rejects invalid operator keys", () => {
    expect(() => encryptAuthTransactionPayloadWithKey({}, "not-a-key")).toThrow(
      "auth.transactionEncryptionKey",
    );
  });
});
