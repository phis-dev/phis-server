import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

function buildPayload(form: string, siteKey: string, issuedAt: string) {
  return `${form}:${siteKey}:${issuedAt}`;
}

function buildSignature(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function normalizeSecret(secret: string) {
  const normalizedSecret = secret.trim();

  if (!normalizedSecret) {
    throw new Error("Missing form guard secret.");
  }

  return normalizedSecret;
}

export function issueFormGuard({
  form,
  siteKey,
  secret,
  issuedAtMs = Date.now(),
}: {
  form: string;
  siteKey: string;
  secret: string;
  issuedAtMs?: number;
}) {
  const normalizedSecret = normalizeSecret(secret);
  const issuedAt = String(issuedAtMs);
  const payload = buildPayload(form, siteKey, issuedAt);
  const formToken = buildSignature(normalizedSecret, payload);

  return { issuedAt, formToken };
}

export function verifyFormGuard({
  form,
  siteKey,
  secret,
  honeypotValue = "",
  issuedAt,
  formToken,
  minAgeMs,
  maxAgeMs,
  nowMs = Date.now(),
}: {
  form: string;
  siteKey: string;
  secret: string;
  honeypotValue?: string;
  issuedAt: string;
  formToken: string;
  minAgeMs: number;
  maxAgeMs: number;
  nowMs?: number;
}) {
  if (honeypotValue.trim()) {
    return { ok: false, reason: "honeypot" };
  }

  const normalizedSecret = normalizeSecret(secret);

  if (!/^\d+$/.test(issuedAt)) {
    return { ok: false, reason: "invalid-issued-at" };
  }

  if (!/^[a-f0-9]{64}$/i.test(formToken)) {
    return { ok: false, reason: "invalid-token-format" };
  }

  const ageMs = nowMs - Number(issuedAt);

  if (!Number.isFinite(ageMs) || ageMs < minAgeMs) {
    return { ok: false, reason: "too-fast", ageMs };
  }

  if (ageMs > maxAgeMs) {
    return { ok: false, reason: "expired", ageMs };
  }

  const payload = buildPayload(form, siteKey, issuedAt);
  const expected = buildSignature(normalizedSecret, payload);
  const actualBuffer = Buffer.from(formToken, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: "invalid-token", ageMs };
  }

  return { ok: true, reason: "ok", ageMs };
}
