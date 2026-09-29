import "server-only";

import { randomUUID } from "node:crypto";

import { getUserAccountByEmail, getUserAccountById } from "@/db/user-accounts";
import {
  consumeAuthTransaction,
  createAuthTransaction,
  getSiteAuthMethod,
  getSiteAuthPolicy,
  getUserIdByExternalIdentity,
  linkExternalIdentity,
} from "@/db/site-auth";
import { getEffectiveUserSiteAuthorization, upsertUserSiteMembership } from "@/db/user-site-memberships";
import { randomToken, sha256Hex } from "@/lib/auth";
import { verifyPasswordHash } from "@/lib/password";
import { normalizeAuthNextPath } from "@/lib/site-auth/contracts";
import {
  decryptAuthTransactionPayload,
  encryptAuthTransactionPayload,
} from "@/lib/site-auth/transaction-crypto";
import type { ValidatedExternalIdentity } from "@/lib/site-auth/external-login";
import { isUserAccountEnabled } from "@/lib/user-flags";

const LINK_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const LINK_PAYLOAD_VERSION = 1;

type IdentityLinkPayload = {
  version: number;
  identity: ValidatedExternalIdentity;
};

function readIdentity(value: unknown): ValidatedExternalIdentity {
  const identity = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (
    typeof identity.issuer !== "string" ||
    typeof identity.subject !== "string" ||
    typeof identity.providerKey !== "string" ||
    (identity.email !== null && typeof identity.email !== "string") ||
    typeof identity.emailVerified !== "boolean"
  ) {
    throw new Error("AUTH_LINK_IDENTITY_INVALID");
  }
  return {
    issuer: identity.issuer,
    subject: identity.subject,
    providerKey: identity.providerKey,
    email: identity.email,
    emailVerified: identity.emailVerified,
  };
}

function readLinkPayload(value: Record<string, unknown>): IdentityLinkPayload {
  if (value.version !== LINK_PAYLOAD_VERSION) {
    throw new Error("AUTH_LINK_TRANSACTION_INVALID");
  }
  return {
    version: LINK_PAYLOAD_VERSION,
    identity: readIdentity(value.identity),
  };
}

export async function createExternalIdentityLinkChallenge(input: {
  siteId: number;
  userId: number;
  methodKey: string;
  providerInstallationKey: string;
  identity: ValidatedExternalIdentity;
  nextPath: string;
}) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + LINK_CHALLENGE_TTL_MS);
  const encrypted = encryptAuthTransactionPayload({
    version: LINK_PAYLOAD_VERSION,
    identity: input.identity,
  });
  await createAuthTransaction({
    id: randomUUID(),
    siteId: input.siteId,
    providerInstallationKey: input.providerInstallationKey,
    userId: input.userId,
    methodKey: input.methodKey,
    stage: "step-up",
    stateHash: sha256Hex(token),
    nonceHash: null,
    payloadCiphertext: encrypted.ciphertextHex,
    payloadIv: encrypted.ivHex,
    payloadAuthTag: encrypted.authTagHex,
    nextPath: normalizeAuthNextPath(input.nextPath),
    expiresAt: expiresAt.toISOString(),
    consumedAt: null,
  });
  return { token, expiresAt };
}

export async function confirmExternalIdentityLink(input: {
  siteId: number;
  token: string;
  password: string;
}) {
  const transaction = await consumeAuthTransaction(input.siteId, sha256Hex(input.token));
  if (
    !transaction ||
    transaction.stage !== "step-up" ||
    !transaction.userId ||
    !transaction.providerInstallationKey
  ) {
    throw new Error("AUTH_LINK_TRANSACTION_INVALID");
  }
  const payload = readLinkPayload(decryptAuthTransactionPayload({
    ciphertextHex: transaction.payloadCiphertext,
    ivHex: transaction.payloadIv,
    authTagHex: transaction.payloadAuthTag,
  }));
  const { identity } = payload;
  if (
    identity.providerKey !== transaction.methodKey ||
    !identity.email ||
    !identity.emailVerified
  ) {
    throw new Error("AUTH_LINK_IDENTITY_INVALID");
  }
  // The installation the flow started with: without it the first enabled one of the method was asked,
  // and a Site's second installation of a provider could never confirm.
  const method = await getSiteAuthMethod(
    input.siteId,
    transaction.methodKey,
    "primary",
    transaction.providerInstallationKey,
  );
  if (
    !method?.enabled ||
    !method.provider?.enabled ||
    method.provider.installationKey !== transaction.providerInstallationKey
  ) {
    throw new Error("AUTH_LINK_METHOD_DISABLED");
  }
  // The confirmation is a password check, and a Site that switched the password off has nothing to
  // check it with -- the same answer the login handler gives, under the code the route already maps.
  const passwordMethod = await getSiteAuthMethod(input.siteId, "password", "primary", null);
  if (passwordMethod?.enabled !== true) {
    throw new Error("AUTH_LINK_PASSWORD_UNAVAILABLE");
  }

  const [user, emailUser, linkedUserId] = await Promise.all([
    getUserAccountById(transaction.userId, input.siteId),
    getUserAccountByEmail(identity.email, input.siteId),
    getUserIdByExternalIdentity(identity.issuer, identity.subject),
  ]);
  if (
    !user ||
    emailUser?.id !== transaction.userId ||
    (linkedUserId !== null && linkedUserId !== transaction.userId)
  ) {
    throw new Error("AUTH_LINK_ACCOUNT_MISMATCH");
  }
  // A person without a membership here reaches this flow only where registration is automatic
  // (AUTHENTICATION.md §7 step 3); the policy is asked again because it may have changed since.
  const isMember = user.siteIds.includes(input.siteId);
  if (!isMember && (await getSiteAuthPolicy(input.siteId))?.registrationMode !== "automatic") {
    throw new Error("AUTH_LINK_ACCOUNT_MISMATCH");
  }
  if (!user.passwordHash) {
    throw new Error("AUTH_LINK_PASSWORD_UNAVAILABLE");
  }
  if (!await verifyPasswordHash(user.passwordHash, input.password)) {
    throw new Error("AUTH_LINK_INVALID_CREDENTIALS");
  }
  if (!isMember) {
    if (!isUserAccountEnabled(user.flags)) {
      throw new Error("AUTH_LINK_ACCOUNT_DISABLED");
    }
    await upsertUserSiteMembership({ userId: user.id, siteId: input.siteId });
  }
  const authorization = await getEffectiveUserSiteAuthorization(user.id, input.siteId);
  if (!isUserAccountEnabled(user.flags) || !authorization.enabled) {
    throw new Error("AUTH_LINK_ACCOUNT_DISABLED");
  }
  await linkExternalIdentity({
    userId: user.id,
    issuer: identity.issuer,
    subject: identity.subject,
    providerKey: identity.providerKey,
  });
  return {
    user,
    authorization,
    methodKey: transaction.methodKey,
    nextPath: transaction.nextPath,
  };
}
