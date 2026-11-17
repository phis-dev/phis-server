import { describe, expect, it } from "vitest";

import {
  createPhiSecretEncryptionKey,
  decryptPhiSecret,
  encryptPhiSecret,
  parsePhiSecretEncryptionKey,
} from "./crypto";

const key = { keyHex: "a".repeat(64), version: 1 };

describe("encryptPhiSecret", () => {
  it("round-trips a value", () => {
    const record = encryptPhiSecret("GOCSPX-not-a-real-secret", key);
    expect(decryptPhiSecret(record, key)).toBe("GOCSPX-not-a-real-secret");
  });

  it("produces a fresh initialization vector every time", () => {
    const first = encryptPhiSecret("same", key);
    const second = encryptPhiSecret("same", key);
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it("records the key version it used", () => {
    expect(encryptPhiSecret("x", { keyHex: key.keyHex, version: 7 }).keyVersion).toBe(7);
  });

  it("stores the parts the column widths expect", () => {
    const record = encryptPhiSecret("x", key);
    expect(record.iv).toHaveLength(12);
    expect(record.authTag).toHaveLength(16);
    expect(record.ciphertext.length).toBeGreaterThan(0);
  });
});

describe("decryptPhiSecret", () => {
  it("refuses a record from another key version before touching the ciphertext", () => {
    const record = encryptPhiSecret("x", { keyHex: key.keyHex, version: 2 });
    expect(() => decryptPhiSecret(record, key)).toThrow(/key version 2/u);
  });

  it("refuses a wrong key rather than returning something", () => {
    const record = encryptPhiSecret("x", key);
    expect(() => decryptPhiSecret(record, { keyHex: "b".repeat(64), version: 1 })).toThrow();
  });

  it("refuses a tampered ciphertext", () => {
    const record = encryptPhiSecret("original", key);
    const flipped = Buffer.from(record.ciphertext);
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 0xff;
    expect(() => decryptPhiSecret({ ...record, ciphertext: flipped }, key)).toThrow();
  });

  it("refuses a tampered authentication tag", () => {
    const record = encryptPhiSecret("original", key);
    expect(() => decryptPhiSecret({ ...record, authTag: Buffer.alloc(16) }, key)).toThrow();
  });
});

describe("parsePhiSecretEncryptionKey", () => {
  it("accepts what createPhiSecretEncryptionKey produces", () => {
    const generated = createPhiSecretEncryptionKey();
    expect(generated).toMatch(/^[0-9a-f]{64}$/u);
    expect(parsePhiSecretEncryptionKey(generated, "key")).toHaveLength(32);
  });

  it("names the setting it rejected", () => {
    expect(() => parsePhiSecretEncryptionKey("short", "secrets.encryptionKey"))
      .toThrow(/secrets\.encryptionKey/u);
  });
});
