import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { PhisAddonHookVerificationDescriptor } from "./contract.ts";
import { claimPhisAddonHookDelivery } from "@/db/addon-hook-deliveries";
import { buildPhiSecretReference } from "@/lib/secrets/reference";
import { resolvePhiSecret } from "@/lib/secrets/resolver";

/**
 * Deciding whether a hook's caller is who it claims to be.
 *
 * A hook is unauthenticated by construction -- that is what makes it reachable by GitHub or by a
 * payment provider -- so "who called this" has exactly one honest answer without a signature: nobody
 * knows. An Add-on that needs to write states how it can be believed, and Core checks it here rather
 * than in each handler: a signature compared with `===` inside somebody's route is a signature compared
 * in variable time, and the check that decides whether an unauthenticated caller may write is not one
 * to leave to whoever writes the next integration.
 *
 * Verification runs over the raw body. Parsing first and re-serialising would compute the digest of
 * something the sender never sent, and every key ordering and every unicode escape would be a way for
 * the two to differ.
 */

export type PhisAddonHookVerificationOutcome =
  /** The signature matched and this delivery had not been taken before. The handler may write. */
  | { outcome: "verified" }
  /** The same delivery id arrived again. Nothing to do, and the sender should stop retrying. */
  | { outcome: "duplicate" }
  /** The caller failed the check. */
  | { outcome: "rejected"; reason: string }
  /** The check could not be made -- no secret configured, no Site. The caller did nothing wrong. */
  | { outcome: "unavailable"; reason: string };

function decodeSignature(value: string, prefix: string | undefined) {
  const trimmed = value.trim();
  if (prefix && !trimmed.startsWith(prefix)) {
    return null;
  }
  const hex = prefix ? trimmed.slice(prefix.length) : trimmed;
  // A digest is hex of a known length; anything else is not a shorter signature, it is a different
  // kind of value, and `Buffer.from` would quietly discard whatever it could not read.
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    return null;
  }
  return Buffer.from(hex, "hex");
}

export async function verifyPhisAddonHookDelivery(input: {
  addonId: string;
  siteKey: string | null;
  descriptor: PhisAddonHookVerificationDescriptor;
  headers: Headers;
  body: Uint8Array;
}): Promise<PhisAddonHookVerificationOutcome> {
  const { addonId, descriptor, headers, body } = input;

  if (!input.siteKey) {
    // The secret is the operator's, set per Site. A hook that cannot name its Site has no secret to be
    // checked against, which the manifest already refuses -- this is the case that should not arise.
    return { outcome: "unavailable", reason: "A verified hook needs a Site." };
  }

  const presented = headers.get(descriptor.header);
  if (!presented) {
    return { outcome: "rejected", reason: `The ${descriptor.header} header is missing.` };
  }

  let secret: string | null;
  try {
    secret = await resolvePhiSecret(
      { kind: "addon", addonId },
      buildPhiSecretReference({
        owner: { kind: "addon", addonId },
        siteKey: input.siteKey,
        name: descriptor.secret,
      }),
    );
  } catch {
    // Exists but unreadable -- a rotated key, a backend that is down. Not the caller's fault, and not
    // something to answer by letting the delivery through.
    return { outcome: "unavailable", reason: `${descriptor.secret} could not be read.` };
  }
  if (!secret) {
    return { outcome: "unavailable", reason: `${descriptor.secret} is not configured for this Site.` };
  }

  const expected = createHmac("sha256", secret).update(body).digest();
  const offered = decodeSignature(presented, descriptor.prefix);
  if (!offered || offered.length !== expected.length) {
    // Length is public -- it is the digest's, not the secret's -- so refusing here leaks nothing that
    // the scheme name in the manifest does not already state.
    return { outcome: "rejected", reason: "The signature is malformed." };
  }
  if (!timingSafeEqual(offered, expected)) {
    return { outcome: "rejected", reason: "The signature does not match." };
  }

  if (!descriptor.deliveryIdHeader) {
    return { outcome: "verified" };
  }

  const deliveryId = headers.get(descriptor.deliveryIdHeader)?.trim() ?? "";
  if (!deliveryId) {
    return {
      outcome: "rejected",
      reason: `The ${descriptor.deliveryIdHeader} header is missing.`,
    };
  }
  if (deliveryId.length > 255) {
    return { outcome: "rejected", reason: "The delivery id is too long." };
  }
  // Claimed only after the signature matched: an unsigned request must not be able to fill this table,
  // nor to spend somebody else's delivery id before the real delivery arrives.
  return await claimPhisAddonHookDelivery(addonId, deliveryId)
    ? { outcome: "verified" }
    : { outcome: "duplicate" };
}
