import "server-only";

import {
  countSiteUserIdentitiesByIssuer,
  listAuthProviderInstallations,
  listSiteAuthMethods,
  type AuthProviderInstallation,
  type SiteAuthMethod,
} from "@/db/site-auth";
import {
  PHI_GITHUB_IDENTITY_ISSUER,
  PHI_OIDC_PROVIDER_ISSUERS,
  buildMicrosoftIssuer,
} from "@/lib/site-auth/contracts";
import { hasSiteAuthSecrets, readSiteAuthSecret } from "@/lib/site-auth/secret-store";
import { normalizeString } from "@/lib/helpers/request";

/**
 * Server-owned provider catalog (AUTHENTICATION.md section 8). The test capability is
 * per-provider metadata: Microsoft supports a real client-credentials round trip; Google and
 * Apple expose OIDC discovery; GitHub has no usable probe and reports not-testable.
 */
export const PHI_AUTH_PROVIDER_CATALOG = [
  { providerKey: "google", label: "Google", tenantMode: false, testCapability: "discovery" },
  { providerKey: "apple", label: "Apple", tenantMode: false, testCapability: "discovery" },
  { providerKey: "github", label: "GitHub", tenantMode: false, testCapability: "none" },
  { providerKey: "microsoft", label: "Microsoft", tenantMode: true, testCapability: "roundtrip" },
] as const;

export type PhiAuthProviderCatalogEntry = (typeof PHI_AUTH_PROVIDER_CATALOG)[number];

export function findAuthProviderCatalogEntry(providerKey: string) {
  return PHI_AUTH_PROVIDER_CATALOG.find((entry) => entry.providerKey === providerKey) ?? null;
}

export function normalizeAuthInstallationKey(value: unknown) {
  const normalized = normalizeString(value).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(normalized) ? normalized : null;
}

/**
 * Derives the installation's issuer from server-owned provider rules. Issuer input never comes
 * from the browser; Microsoft derives it from the tenant config.
 */
export function deriveAuthInstallationIssuer(providerKey: string, config: Record<string, unknown>) {
  if (providerKey === "google") return PHI_OIDC_PROVIDER_ISSUERS.google;
  if (providerKey === "apple") return PHI_OIDC_PROVIDER_ISSUERS.apple;
  if (providerKey === "github") return PHI_GITHUB_IDENTITY_ISSUER;
  if (providerKey === "microsoft") {
    const tenant = normalizeString(config.tenant) || "common";
    if (!/^(?:common|organizations|consumers|[a-f0-9-]{36})$/i.test(tenant)) return null;
    return buildMicrosoftIssuer(tenant.toLowerCase());
  }
  return null;
}

/**
 * The effective redirect URI is per Site and per provider: installations of one provider share
 * the provider's callback route, and the origin defaults to the Site's public base URL with an
 * optional per-installation override from the allowedCallbackOrigins policy.
 */
export function buildAuthInstallationCallbackUrl(
  sitePublicUrl: string,
  installation: Pick<AuthProviderInstallation, "providerKey" | "callbackOrigin">,
) {
  return new URL(
    `/api/auth/providers/${encodeURIComponent(installation.providerKey)}/callback`,
    installation.callbackOrigin ?? sitePublicUrl,
  ).toString();
}

/**
 * `configuredSecrets` is which references exist, resolved once by the caller.
 *
 * The status is whether a credential is stored, not what it is, so this never needs a plaintext -- and
 * asking per installation would decrypt once per row for an answer that is a row count.
 */
export function serializeAuthInstallation(
  installation: AuthProviderInstallation,
  method: Pick<SiteAuthMethod, "enabled" | "sortOrder"> | null,
  sitePublicUrl: string,
  configuredSecrets: ReadonlySet<string>,
  linkedIdentities = 0,
) {
  return {
    installationKey: installation.installationKey,
    providerKey: installation.providerKey,
    issuer: installation.issuer,
    clientId: installation.clientId,
    enabled: installation.enabled,
    tenant: typeof installation.config.tenant === "string" ? installation.config.tenant : null,
    callbackOrigin: installation.callbackOrigin,
    callbackUri: buildAuthInstallationCallbackUrl(sitePublicUrl, installation),
    secretStatus:
      installation.secretReference && configuredSecrets.has(installation.secretReference)
        ? "configured"
        : "missing",
    validation: installation.validation,
    loginEnabled: method?.enabled ?? false,
    sortOrder: method?.sortOrder ?? 10,
    linkedIdentities,
  };
}

export async function listSerializedAuthInstallations(siteId: number, sitePublicUrl: string) {
  const [installations, methods] = await Promise.all([
    listAuthProviderInstallations(siteId),
    listSiteAuthMethods(siteId, "primary"),
  ]);
  const methodByInstallation = new Map(
    methods
      .filter((method) => method.providerInstallationKey)
      .map((method) => [method.providerInstallationKey!, method]),
  );
  const identityCountByIssuer = new Map<string, number>();
  for (const issuer of new Set(installations.map((installation) => installation.issuer))) {
    identityCountByIssuer.set(issuer, await countSiteUserIdentitiesByIssuer(siteId, issuer));
  }
  const configuredSecrets = await hasSiteAuthSecrets(
    installations.map((installation) => installation.secretReference),
  );
  return installations.map((installation) =>
    serializeAuthInstallation(
      installation,
      methodByInstallation.get(installation.installationKey) ?? null,
      sitePublicUrl,
      configuredSecrets,
      identityCountByIssuer.get(installation.issuer) ?? 0,
    ));
}

/**
 * Lockout guard: a change may never leave the Site without any enabled primary login method
 * backed by a usable credential (password, or an enabled installation with a stored secret).
 */
export async function siteWouldRetainPrimaryLogin(
  siteId: number,
  change: {
    removedInstallationKey?: string;
    disabledInstallationKey?: string;
    disabledLoginInstallationKey?: string;
    disablePasswordMethod?: boolean;
  },
) {
  const [installations, methods] = await Promise.all([
    listAuthProviderInstallations(siteId),
    listSiteAuthMethods(siteId, "primary"),
  ]);
  const installationsByKey = new Map(installations.map((entry) => [entry.installationKey, entry]));
  const configuredSecrets = await hasSiteAuthSecrets(
    installations.map((entry) => entry.secretReference),
  );
  return methods.some((method) => {
    if (!method.enabled) return false;
    if (!method.providerInstallationKey) {
      return method.methodKey === "password" && change.disablePasswordMethod !== true;
    }
    const key = method.providerInstallationKey;
    if (key === change.removedInstallationKey || key === change.disabledLoginInstallationKey) {
      return false;
    }
    const installation = installationsByKey.get(key);
    if (!installation || key === change.disabledInstallationKey) return false;
    return (
      installation.enabled &&
      Boolean(installation.secretReference && configuredSecrets.has(installation.secretReference))
    );
  });
}

/**
 * Validates one installation according to the provider's declared test capability. Microsoft
 * runs a real client-credentials round trip; discovery providers verify issuer metadata; a
 * provider without a probe reports not-testable rather than a fake pass.
 */
export async function testAuthInstallation(
  installation: AuthProviderInstallation,
): Promise<{ status: "ok" | "failed" | "not-testable"; detail: string | null }> {
  const catalogEntry = findAuthProviderCatalogEntry(installation.providerKey);
  if (!catalogEntry || catalogEntry.testCapability === "none") {
    return { status: "not-testable", detail: null };
  }
  const clientSecret = await readSiteAuthSecret(installation.secretReference);
  if (!clientSecret) {
    return { status: "failed", detail: "Client secret is not configured." };
  }

  try {
    const discoveryUrl = new URL(
      "/.well-known/openid-configuration",
      `${installation.issuer.replace(/\/+$/, "")}/`,
    );
    const discoveryResponse = await fetch(discoveryUrl, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const discovery = (await discoveryResponse.json().catch(() => null)) as
      | { issuer?: string; token_endpoint?: string }
      | null;
    if (!discoveryResponse.ok || typeof discovery?.issuer !== "string") {
      return { status: "failed", detail: `Discovery failed (${discoveryResponse.status}).` };
    }
    if (catalogEntry.testCapability === "discovery") {
      if (discovery.issuer !== installation.issuer) {
        return { status: "failed", detail: "Discovery issuer does not match the installation." };
      }
      return { status: "ok", detail: "Discovery verified." };
    }

    // Round-trip providers: the multi-tenant Microsoft issuers (common/organizations/consumers)
    // publish a templated discovery issuer and cannot mint client-credentials tokens, so only a
    // concrete tenant id gets the real round trip; the shared tenants verify discovery reachability.
    const tenant = normalizeString(installation.config.tenant) || "common";
    if (!/^[a-f0-9-]{36}$/i.test(tenant)) {
      return { status: "ok", detail: "Discovery verified. A credential round trip requires a tenant id." };
    }
    if (typeof discovery.token_endpoint !== "string") {
      return { status: "failed", detail: "Discovery exposes no token endpoint." };
    }
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: installation.clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const tokenPayload = (await tokenResponse.json().catch(() => null)) as
      | { access_token?: string; error?: string; error_description?: string }
      | null;
    if (tokenResponse.ok && typeof tokenPayload?.access_token === "string") {
      return { status: "ok", detail: "Client credentials verified." };
    }
    return {
      status: "failed",
      detail: tokenPayload?.error_description?.slice(0, 256) ??
        tokenPayload?.error ??
        `Token endpoint rejected the credentials (${tokenResponse.status}).`,
    };
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message.slice(0, 256) : "Validation request failed.",
    };
  }
}
