import "server-only";

import { randomUUID } from "node:crypto";

import * as oidc from "openid-client";

import {
  consumeAuthTransaction,
  createAuthTransaction,
  deleteExpiredAuthTransactions,
  getSiteAuthMethod,
  type AuthProviderInstallation,
} from "@/db/site-auth";
import { sha256Hex } from "@/lib/auth";
import {
  PHI_GITHUB_IDENTITY_ISSUER,
  PHI_MICROSOFT_CONSUMER_TENANT_ID,
  PHI_MICROSOFT_IDENTITY_ORIGIN,
  PHI_OIDC_PROVIDER_ISSUERS,
  buildMicrosoftIssuer,
  normalizeAuthNextPath,
  readStoredPhiAuthConfigList,
} from "@/lib/site-auth/contracts";
import { readSiteAuthSecret } from "@/lib/site-auth/secret-store";
import {
  decryptAuthTransactionPayload,
  encryptAuthTransactionPayload,
} from "@/lib/site-auth/transaction-crypto";
import type { ValidatedExternalIdentity } from "@/lib/site-auth/external-login";

type ProviderTransactionPayload = {
  state: string;
  nonce: string;
  pkceVerifier: string;
  callbackUrl: string;
};

function isTrue(value: unknown) {
  return value === true || value === "true";
}

function readTransactionPayload(value: Record<string, unknown>): ProviderTransactionPayload {
  const state = typeof value.state === "string" ? value.state : "";
  const nonce = typeof value.nonce === "string" ? value.nonce : "";
  const pkceVerifier = typeof value.pkceVerifier === "string" ? value.pkceVerifier : "";
  const callbackUrl = typeof value.callbackUrl === "string" ? value.callbackUrl : "";
  if (!state || !nonce || !pkceVerifier || !callbackUrl) {
    throw new Error("Invalid Auth transaction payload.");
  }
  return { state, nonce, pkceVerifier, callbackUrl };
}

function buildCallbackUrl(
  sitePublicUrl: string,
  methodKey: string,
  callbackOrigin: string | null = null,
) {
  return new URL(
    `/api/auth/providers/${encodeURIComponent(methodKey)}/callback`,
    callbackOrigin ?? sitePublicUrl,
  ).toString();
}

function assertProviderInstallation(input: AuthProviderInstallation, methodKey: string) {
  if (!input.enabled || input.providerKey !== methodKey) {
    throw new Error("AUTH_PROVIDER_UNAVAILABLE");
  }
  if (methodKey === "google" && input.issuer !== PHI_OIDC_PROVIDER_ISSUERS.google) {
    throw new Error("AUTH_PROVIDER_ISSUER_MISMATCH");
  }
  if (methodKey === "apple" && input.issuer !== PHI_OIDC_PROVIDER_ISSUERS.apple) {
    throw new Error("AUTH_PROVIDER_ISSUER_MISMATCH");
  }
  if (methodKey === "github" && input.issuer !== PHI_GITHUB_IDENTITY_ISSUER) {
    throw new Error("AUTH_PROVIDER_ISSUER_MISMATCH");
  }
  if (methodKey === "microsoft") {
    const tenant = typeof input.config.tenant === "string" && input.config.tenant.trim()
      ? input.config.tenant.trim().toLowerCase()
      : "common";
    if (
      !/^(?:common|organizations|consumers|[a-f0-9-]{36})$/.test(tenant) ||
      input.issuer !== buildMicrosoftIssuer(tenant)
    ) {
      throw new Error("AUTH_PROVIDER_ISSUER_MISMATCH");
    }
  }
}

function validateMicrosoftClaims(
  installation: AuthProviderInstallation,
  claims: Record<string, unknown>,
) {
  const tenant = typeof installation.config.tenant === "string" && installation.config.tenant.trim()
    ? installation.config.tenant.trim().toLowerCase()
    : "common";
  const tenantId = typeof claims.tid === "string" ? claims.tid.toLowerCase() : "";
  const issuer = typeof claims.iss === "string" ? claims.iss : "";
  if (!tenantId || issuer !== `${PHI_MICROSOFT_IDENTITY_ORIGIN}/${tenantId}/v2.0`) {
    return false;
  }
  if (/^[a-f0-9-]{36}$/.test(tenant)) return tenantId === tenant;
  if (tenant === "consumers") return tenantId === PHI_MICROSOFT_CONSUMER_TENANT_ID;
  if (tenant === "organizations") return tenantId !== PHI_MICROSOFT_CONSUMER_TENANT_ID;
  return tenant === "common";
}

async function buildOidcConfiguration(installation: AuthProviderInstallation, clientSecret: string) {
  return oidc.discovery(
    new URL(installation.issuer),
    installation.clientId,
    { client_secret: clientSecret },
    oidc.ClientSecretPost(clientSecret),
  );
}

export async function startProviderAuthentication(input: {
  siteId: number;
  sitePublicUrl: string;
  methodKey: string;
  installationKey?: string | null;
  nextPath?: unknown;
}) {
  const method = await getSiteAuthMethod(
    input.siteId,
    input.methodKey,
    "primary",
    input.installationKey ?? undefined,
  );
  if (!method?.enabled || !method.provider?.enabled) {
    throw new Error("AUTH_METHOD_DISABLED");
  }
  const installation = method.provider;
  assertProviderInstallation(installation, input.methodKey);
  const clientSecret = await readSiteAuthSecret(installation.secretReference);
  if (!clientSecret) {
    throw new Error("AUTH_PROVIDER_SECRET_MISSING");
  }

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const pkceVerifier = oidc.randomPKCECodeVerifier();
  const pkceChallenge = await oidc.calculatePKCECodeChallenge(pkceVerifier);
  const callbackUrl = buildCallbackUrl(input.sitePublicUrl, input.methodKey, installation.callbackOrigin);
  const nextPath = normalizeAuthNextPath(input.nextPath);
  const encrypted = encryptAuthTransactionPayload({ state, nonce, pkceVerifier, callbackUrl });
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await createAuthTransaction({
    id: randomUUID(),
    siteId: input.siteId,
    providerInstallationKey: installation.installationKey,
    userId: null,
    methodKey: input.methodKey,
    stage: "primary",
    stateHash: sha256Hex(state),
    nonceHash: sha256Hex(nonce),
    payloadCiphertext: encrypted.ciphertextHex,
    payloadIv: encrypted.ivHex,
    payloadAuthTag: encrypted.authTagHex,
    nextPath,
    expiresAt: expiresAt.toISOString(),
    consumedAt: null,
  });
  void deleteExpiredAuthTransactions().catch(() => undefined);

  if (input.methodKey === "github") {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", installation.clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    const scope = readStoredPhiAuthConfigList(installation.config, "scopes").join(" ") || "read:user user:email";
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { redirectUrl: url.toString(), nextPath, state, expiresAt };
  }

  const config = await buildOidcConfiguration(installation, clientSecret);
  const scope = readStoredPhiAuthConfigList(installation.config, "scopes").join(" ") || "openid email profile";
  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl,
    scope,
    state,
    nonce,
    code_challenge: pkceChallenge,
    code_challenge_method: "S256",
    ...(typeof installation.config.prompt === "string"
      ? { prompt: installation.config.prompt }
      : {}),
  });
  return { redirectUrl: authorizationUrl.toString(), nextPath, state, expiresAt };
}

async function completeGithubAuthentication(input: {
  installation: AuthProviderInstallation;
  clientSecret: string;
  code: string;
  callbackUrl: string;
  pkceVerifier: string;
}) {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.installation.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.callbackUrl,
      code_verifier: input.pkceVerifier,
    }),
    cache: "no-store",
  });
  const tokenPayload = await tokenResponse.json() as { access_token?: unknown; error?: unknown };
  const accessToken = typeof tokenPayload.access_token === "string" ? tokenPayload.access_token : "";
  if (!tokenResponse.ok || !accessToken) {
    throw new Error("AUTH_PROVIDER_TOKEN_EXCHANGE_FAILED");
  }
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "x-github-api-version": "2022-11-28",
  };
  const [userResponse, emailsResponse] = await Promise.all([
    fetch("https://api.github.com/user", { headers, cache: "no-store" }),
    fetch("https://api.github.com/user/emails", { headers, cache: "no-store" }),
  ]);
  if (!userResponse.ok || !emailsResponse.ok) {
    throw new Error("AUTH_PROVIDER_PROFILE_FAILED");
  }
  const user = await userResponse.json() as { id?: unknown };
  const emails = await emailsResponse.json() as Array<{
    email?: unknown;
    primary?: unknown;
    verified?: unknown;
  }>;
  if (!(typeof user.id === "number" || typeof user.id === "string")) {
    throw new Error("AUTH_PROVIDER_SUBJECT_MISSING");
  }
  const verifiedEmail = Array.isArray(emails)
    ? emails.find((entry) => entry.primary === true && entry.verified === true && typeof entry.email === "string") ??
      emails.find((entry) => entry.verified === true && typeof entry.email === "string")
    : null;

  const allowedOrganizations = readStoredPhiAuthConfigList(input.installation.config, "allowedOrganizations")
    .map((value) => value.toLowerCase());
  if (allowedOrganizations.length > 0) {
    const memberships = await Promise.all(allowedOrganizations.map(async (organization) => {
      const response = await fetch(
        `https://api.github.com/user/memberships/orgs/${encodeURIComponent(organization)}`,
        { headers, cache: "no-store" },
      );
      if (!response.ok) {
        return false;
      }
      const payload = await response.json() as { state?: unknown };
      return payload.state === "active";
    }));
    if (!memberships.some(Boolean)) {
      throw new Error("AUTH_PROVIDER_RESTRICTION_FAILED");
    }
  }

  return {
    issuer: PHI_GITHUB_IDENTITY_ISSUER,
    subject: String(user.id),
    providerKey: "github",
    email: verifiedEmail && typeof verifiedEmail.email === "string"
      ? verifiedEmail.email.trim().toLowerCase()
      : null,
    emailVerified: Boolean(verifiedEmail),
  } satisfies ValidatedExternalIdentity;
}

export async function completeProviderAuthentication(input: {
  siteId: number;
  sitePublicUrl: string;
  methodKey: string;
  requestUrl: string;
}) {
  const callback = new URL(input.requestUrl);
  const state = callback.searchParams.get("state")?.trim() ?? "";
  if (!state) {
    throw new Error("AUTH_STATE_MISSING");
  }
  const transaction = await consumeAuthTransaction(input.siteId, sha256Hex(state));
  if (!transaction || transaction.methodKey !== input.methodKey || transaction.stage !== "primary") {
    throw new Error("AUTH_TRANSACTION_INVALID");
  }
  const payload = readTransactionPayload(decryptAuthTransactionPayload({
    ciphertextHex: transaction.payloadCiphertext,
    ivHex: transaction.payloadIv,
    authTagHex: transaction.payloadAuthTag,
  }));
  if (payload.state !== state || transaction.nonceHash !== sha256Hex(payload.nonce)) {
    throw new Error("AUTH_TRANSACTION_MISMATCH");
  }

  const method = await getSiteAuthMethod(
    input.siteId,
    input.methodKey,
    "primary",
    transaction.providerInstallationKey,
  );
  if (!method?.enabled || !method.provider?.enabled) {
    throw new Error("AUTH_METHOD_DISABLED");
  }
  const installation = method.provider;
  assertProviderInstallation(installation, input.methodKey);
  if (payload.callbackUrl !== buildCallbackUrl(input.sitePublicUrl, input.methodKey, installation.callbackOrigin)) {
    throw new Error("AUTH_TRANSACTION_MISMATCH");
  }
  const clientSecret = await readSiteAuthSecret(installation.secretReference);
  if (!clientSecret) {
    throw new Error("AUTH_PROVIDER_SECRET_MISSING");
  }

  let identity: ValidatedExternalIdentity;
  if (input.methodKey === "github") {
    const code = callback.searchParams.get("code")?.trim() ?? "";
    if (!code) {
      throw new Error("AUTH_PROVIDER_CODE_MISSING");
    }
    identity = await completeGithubAuthentication({
      installation,
      clientSecret,
      code,
      callbackUrl: payload.callbackUrl,
      pkceVerifier: payload.pkceVerifier,
    });
  } else {
    const config = await buildOidcConfiguration(installation, clientSecret);
    const registeredCallback = new URL(payload.callbackUrl);
    registeredCallback.search = callback.search;
    const tokens = await oidc.authorizationCodeGrant(config, registeredCallback, {
      pkceCodeVerifier: payload.pkceVerifier,
      expectedState: payload.state,
      expectedNonce: payload.nonce,
    });
    const claims = tokens.claims();
    if (
      !claims?.sub ||
      (input.methodKey === "microsoft"
        ? !validateMicrosoftClaims(installation, claims as Record<string, unknown>)
        : claims.iss !== installation.issuer)
    ) {
      throw new Error("AUTH_PROVIDER_IDENTITY_INVALID");
    }
    const hostedDomains = readStoredPhiAuthConfigList(installation.config, "hostedDomains")
      .map((value) => value.toLowerCase());
    if (
      hostedDomains.length > 0 &&
      (typeof claims.hd !== "string" || !hostedDomains.includes(claims.hd.toLowerCase()))
    ) {
      throw new Error("AUTH_PROVIDER_RESTRICTION_FAILED");
    }
    identity = {
      issuer: installation.issuer,
      subject: claims.sub,
      providerKey: installation.providerKey,
      email: typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null,
      emailVerified: isTrue(claims.email_verified),
    };
  }

  return {
    identity,
    nextPath: transaction.nextPath,
    providerInstallationKey: installation.installationKey,
    trustedForAutoLink: installation.config.trustedEmailLink === true,
  };
}
