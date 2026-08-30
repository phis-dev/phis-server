import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;

function encodeBase32(input: Buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function hotp(secret: Buffer, counter: number) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = (
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  ) >>> 0;
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, "0");
}

export function createTotpSecret() {
  const secret = randomBytes(20);
  return {
    secret,
    manualKey: encodeBase32(secret),
  };
}

export function buildTotpUri(input: {
  manualKey: string;
  issuer: string;
  accountName: string;
}) {
  const label = `${input.issuer}:${input.accountName}`;
  const query = new URLSearchParams({
    secret: input.manualKey,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}

export function verifyTotpCode(secret: Buffer, value: unknown, now = Date.now()) {
  const code = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(code)) {
    return false;
  }
  const counter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  return [-1, 0, 1].some((offset) => {
    const expected = Buffer.from(hotp(secret, counter + offset), "utf8");
    const supplied = Buffer.from(code, "utf8");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  });
}

export function createTotpCode(secret: Buffer, now = Date.now()) {
  return hotp(secret, Math.floor(now / 1000 / TOTP_PERIOD_SECONDS));
}
