import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildAppleClientSecret, normalizeAppleSigningKey, readAppleSigningKey } from "./apple-client-secret";

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

describe("the client secret signed for Apple", () => {
  it("is an ES256 JWT Apple can check against the key", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const token = buildAppleClientSecret({
      teamId: "AB12CD34EF",
      keyId: "ZY98XW76VU",
      clientId: "com.example.web.signin",
      signingKey: pem,
      now,
    });
    const [header, payload, signature] = token.split(".");
    expect(decode(header!)).toEqual({ alg: "ES256", kid: "ZY98XW76VU", typ: "JWT" });
    const issuedAt = Math.floor(now.getTime() / 1000);
    expect(decode(payload!)).toEqual({
      iss: "AB12CD34EF",
      iat: issuedAt,
      exp: issuedAt + 300,
      aud: "https://appleid.apple.com",
      sub: "com.example.web.signin",
    });
    expect(verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    )).toBe(true);
  });

  it("refuses to sign without a usable key or ids", () => {
    const base = { teamId: "AB12CD34EF", keyId: "ZY98XW76VU", clientId: "com.example.web", signingKey: pem };
    expect(() => buildAppleClientSecret({ ...base, teamId: "" })).toThrow("AUTH_PROVIDER_SECRET_INVALID");
    expect(() => buildAppleClientSecret({ ...base, signingKey: "secret" })).toThrow("AUTH_PROVIDER_SECRET_INVALID");
  });
});

describe("the signing key as it was pasted", () => {
  it("reads the PEM, the PEM without line breaks, and the bare base64", () => {
    const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    for (const pasted of [pem, pem.replace(/\n/g, ""), body, `  ${pem}  `]) {
      expect(normalizeAppleSigningKey(pasted)).toBe(pem);
    }
  });

  it("refuses a key on another curve", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey
      .export({ format: "pem", type: "pkcs8" }).toString();
    expect(readAppleSigningKey(other)).toBeNull();
    expect(readAppleSigningKey("not a key")).toBeNull();
  });
});
