import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getPhisConfigSync } from "@/lib/config";

/**
 * The signature under a link that has to survive in a mailbox.
 *
 * An unsubscribe link cannot be a stored one-time token: a stored hash cannot be read back, so the link
 * could never be rendered a second time, and it has to keep working for as long as the mail carrying it
 * exists. It cannot be a bare id either, because then anybody could unsubscribe anybody. So it is the
 * recipient plus a signature over the recipient and a salt kept beside the membership -- the salt is
 * public and proves nothing, and this key is what makes the pair unforgeable.
 *
 * Installation-wide, out of the database, and rotating it invalidates every link still in a mailbox --
 * which is why it is configuration a backup has to carry rather than something generated on demand.
 */
function getNotificationLinkSecret() {
  const secret = getPhisConfigSync().notifications?.linkSecret?.trim() ?? "";
  if (!secret) {
    throw new Error(
      "Missing notifications.linkSecret in runtime config; an unsubscribe link cannot be signed without it.",
    );
  }
  return secret;
}

/** The public half kept beside a membership. Sixteen bytes, so a salt is not worth guessing. */
export function createPhiNotificationLinkSalt() {
  return randomBytes(16).toString("hex");
}

function signUnsubscribe(siteId: number, userId: number, salt: string) {
  return createHmac("sha256", getNotificationLinkSecret())
    .update(`unsubscribe:${siteId}:${userId}:${salt}`)
    .digest("base64url");
}

/**
 * The value a link carries: who it is for, and the proof that it was issued.
 *
 * The id is in the clear because the verifier needs it to find the salt, and hiding it would buy nothing
 * -- the signature is what authorises, and an id alone opens nothing.
 */
export function buildPhiUnsubscribeToken(input: { siteId: number; userId: number; salt: string }) {
  return `${input.userId}.${signUnsubscribe(input.siteId, input.userId, input.salt)}`;
}

/** Which account a link claims to be for, before anything is verified. `null` when it is not a link. */
export function readPhiUnsubscribeTokenSubject(rawToken: string) {
  const [idPart, signature] = rawToken.split(".");
  const userId = Number(idPart);
  if (!signature || !Number.isInteger(userId) || userId <= 0) {
    return null;
  }
  return { userId, signature };
}

/**
 * Whether this link was issued for this membership, compared in constant time.
 *
 * The caller has already looked up the salt, which is what makes a wrong id and a wrong signature the
 * same answer here: `false` says only that the link does not hold.
 */
export function verifyPhiUnsubscribeToken(input: {
  siteId: number;
  userId: number;
  salt: string;
  signature: string;
}) {
  const expected = Buffer.from(signUnsubscribe(input.siteId, input.userId, input.salt));
  const received = Buffer.from(input.signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Where the link points, on the Site's own base URL and in the reader's language.
 *
 * Built from `publicBaseUrl` rather than from a request, because the drain has no request -- and because a
 * link in a mail must not be able to name a host somebody else chose.
 */
export function buildPhiUnsubscribeUrl(input: {
  publicBaseUrl: string;
  locale: string;
  token: string;
}) {
  const base = input.publicBaseUrl.trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("Missing site public base URL.");
  }
  return `${base}/${input.locale}/unsubscribe?token=${encodeURIComponent(input.token)}`;
}
