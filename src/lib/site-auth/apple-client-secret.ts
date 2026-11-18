import "server-only";

import { createPrivateKey, sign, type KeyObject } from "node:crypto";

import { PHI_OIDC_PROVIDER_ISSUERS } from "@/lib/site-auth/contracts";

/*
 * Sign in with Apple has no client secret to copy. What Apple hands out is a signing key -- the `.p8`
 * file under Keys, downloadable once -- and the client secret is a short JWT the client signs with it
 * for every token request: ES256, the key's id in the header, the developer team as issuer, the
 * Services ID as subject, Apple as audience. Apple accepts such a token for up to six months; this one
 * lives five minutes, because it is made for the one token request in front of it and a secret that
 * expires on its own is one nobody has to remember to renew.
 *
 * The stored secret of an Apple installation is therefore the key, not a token. It is entered through
 * a password field, which drops the line breaks of a PEM file, so the key is read from whatever is left
 * of it: the PEM with or without its breaks, or the bare base64 between the armour lines.
 */

const APPLE_ID_PATTERN = /^[A-Z0-9]{10}$/u;
const CLIENT_SECRET_LIFETIME_SECONDS = 5 * 60;

/** A Team ID and a Key ID are both ten capitals and digits, as the Developer account shows them. */
export function isAppleDeveloperId(value: string) {
  return APPLE_ID_PATTERN.test(value);
}

/** The key out of what was pasted, or `null` when it is not an EC P-256 private key. */
export function readAppleSigningKey(value: string): KeyObject | null {
  const body = value
    .replace(/-----BEGIN [A-Z ]+-----/gu, "")
    .replace(/-----END [A-Z ]+-----/gu, "")
    .replace(/\s+/gu, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) {
    return null;
  }
  try {
    const key = createPrivateKey({ key: Buffer.from(body, "base64"), format: "der", type: "pkcs8" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      ? key
      : null;
  } catch {
    return null;
  }
}

/** The key in the one shape it is stored in: a PKCS #8 PEM with its line breaks. */
export function normalizeAppleSigningKey(value: string): string | null {
  const key = readAppleSigningKey(value);
  return key ? key.export({ format: "pem", type: "pkcs8" }).toString() : null;
}

function base64url(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

/** The client secret for one token request at Apple. */
export function buildAppleClientSecret(input: {
  teamId: string;
  keyId: string;
  clientId: string;
  signingKey: string;
  now?: Date;
}) {
  if (!isAppleDeveloperId(input.teamId) || !isAppleDeveloperId(input.keyId)) {
    throw new Error("AUTH_PROVIDER_SECRET_INVALID");
  }
  const key = readAppleSigningKey(input.signingKey);
  if (!key) {
    throw new Error("AUTH_PROVIDER_SECRET_INVALID");
  }
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: input.keyId, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: input.teamId,
    iat: issuedAt,
    exp: issuedAt + CLIENT_SECRET_LIFETIME_SECONDS,
    aud: PHI_OIDC_PROVIDER_ISSUERS.apple,
    sub: input.clientId,
  }));
  // JOSE wants the raw r||s pair, not the DER sequence Node signs into by default.
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${base64url(signature)}`;
}
