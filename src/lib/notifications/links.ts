import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getPhisConfigSync } from "@/lib/config";

/**
 * The signature under a link that has to survive in a mailbox.
 *
 * An unsubscribe link cannot be a stored one-time token: a stored hash cannot be read back, so the link
 * could never be rendered a second time, and it has to keep working for as long as the mail carrying it
 * exists. It cannot be a bare id either, because then anybody could unsubscribe anybody. So it is the
 * recipient and the occasion plus a signature over both and a salt kept beside the membership -- the
 * salt is public and proves nothing, and this key is what makes the link unforgeable.
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

/**
 * Which circulars a link leaves: one occasion of one declarer, `providerId` as the outbox row carries it
 * (`@phis/server/core` or an Add-on id) and the occasion's name. Somebody who leaves a newsletter has not
 * left every other circular the Site may send, so the occasion is part of what the link is bound to.
 */
export type PhiUnsubscribeOccasion = { providerId: string; occasion: string };

const OCCASION_SEPARATOR = "|";

function encodeOccasion(occasion: PhiUnsubscribeOccasion) {
  return `${occasion.providerId}${OCCASION_SEPARATOR}${occasion.occasion}`;
}

function signUnsubscribe(siteId: number, userId: number, salt: string, occasion: PhiUnsubscribeOccasion) {
  return createHmac("sha256", getNotificationLinkSecret())
    .update(`unsubscribe:${siteId}:${userId}:${salt}:${encodeOccasion(occasion)}`)
    .digest("base64url");
}

/**
 * The value a link carries: who it is for, which occasion it leaves, and the proof that it was issued.
 *
 * The id and the occasion are in the clear because the verifier needs the id to find the salt and the
 * occasion to know what to record, and hiding them would buy nothing -- the signature is what authorises,
 * and an id alone opens nothing.
 */
export function buildPhiUnsubscribeToken(input: {
  siteId: number;
  userId: number;
  salt: string;
  occasion: PhiUnsubscribeOccasion;
}) {
  const occasion = Buffer.from(encodeOccasion(input.occasion)).toString("base64url");
  return `${input.userId}.${occasion}.${signUnsubscribe(input.siteId, input.userId, input.salt, input.occasion)}`;
}

/**
 * Which account and which occasion a link claims, before anything is verified. `null` when it is not a
 * link.
 */
export function readPhiUnsubscribeTokenSubject(rawToken: string) {
  const parts = rawToken.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [idPart, occasionPart, signature] = parts as [string, string, string];
  const userId = Number(idPart);
  if (!signature || !occasionPart || !/^\d+$/u.test(idPart) || !Number.isInteger(userId) || userId <= 0) {
    return null;
  }
  const decoded = Buffer.from(occasionPart, "base64url").toString("utf8");
  const separator = decoded.indexOf(OCCASION_SEPARATOR);
  const providerId = separator > 0 ? decoded.slice(0, separator) : "";
  const occasion = separator > 0 ? decoded.slice(separator + 1) : "";
  if (!providerId || !occasion || occasion.includes(OCCASION_SEPARATOR)) {
    return null;
  }
  return { userId, occasion: { providerId, occasion } satisfies PhiUnsubscribeOccasion, signature };
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
  occasion: PhiUnsubscribeOccasion;
  signature: string;
}) {
  const expected = Buffer.from(signUnsubscribe(input.siteId, input.userId, input.salt, input.occasion));
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
