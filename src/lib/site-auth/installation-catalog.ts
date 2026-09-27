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
  readPhiAuthConfigList,
} from "@/lib/site-auth/contracts";
import { hasSiteAuthSecrets, readSiteAuthSecret } from "@/lib/site-auth/secret-store";
import { normalizeString } from "@/lib/helpers/request";

/**
 * Server-owned provider catalog (AUTHENTICATION.md section 8). The test capability is
 * per-provider metadata: Microsoft supports a real client-credentials round trip; Google and
 * Apple expose OIDC discovery; GitHub has no usable probe and reports not-testable.
 *
 * `restrictionKey` is the one thing a provider can be narrowed by, under the name the provider flow
 * reads it as: Google answers with an `hd` claim and is narrowed by hosted domain, GitHub is asked
 * whether the account is an active member of an organization. Apple emits no such claim and Microsoft
 * narrows through its tenant instead, so neither takes one -- and a restriction stored under a name
 * nobody reads is worse than none, because it reads like a closed door that is open.
 *
 * `promptMode` is whether the authorization request carries an OAuth `prompt`. The OIDC providers pass
 * it through; GitHub's authorize endpoint has no such parameter.
 */
export const PHI_AUTH_PROVIDER_CATALOG = [
  {
    providerKey: "google",
    label: "Google",
    tenantMode: false,
    testCapability: "discovery",
    restrictionKey: "hostedDomains",
    promptMode: true,
  },
  {
    providerKey: "apple",
    label: "Apple",
    tenantMode: false,
    testCapability: "discovery",
    restrictionKey: null,
    promptMode: true,
  },
  {
    providerKey: "github",
    label: "GitHub",
    tenantMode: false,
    testCapability: "none",
    restrictionKey: "allowedOrganizations",
    promptMode: false,
  },
  {
    providerKey: "microsoft",
    label: "Microsoft",
    tenantMode: true,
    testCapability: "roundtrip",
    restrictionKey: null,
    promptMode: true,
  },
] as const;

export type PhiAuthProviderCatalogEntry = (typeof PHI_AUTH_PROVIDER_CATALOG)[number];

export function findAuthProviderCatalogEntry(providerKey: string) {
  return PHI_AUTH_PROVIDER_CATALOG.find((entry) => entry.providerKey === providerKey) ?? null;
}

/** The config key this provider's login restriction is stored under, or `null` where it has none. */
function catalogRestrictionKey(providerKey: string) {
  return findAuthProviderCatalogEntry(providerKey)?.restrictionKey ?? null;
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
 * One writer for an installation's provider config, shared by the create and the update route.
 *
 * Everything the provider flow reads out of `config` is written here and nowhere else. It was written
 * nowhere at all for a long time: the two routes each built a fresh `config` object and set `tenant` on
 * it, so `scopes`, the per-provider restriction, `prompt` and `trustedEmailLink` were read at every
 * login and settable only by editing the JSON document in the database by hand. A restriction that can
 * only be written out of band is a restriction nobody sets.
 *
 * A stated key the provider has no use for is refused rather than stored: a `tenant` on GitHub or an
 * organization on Apple would sit in the document looking like configuration and do nothing. Stated is
 * the word that matters -- the Admin Form posts one body for every provider and leaves the fields that
 * do not apply empty, and an empty field says nothing rather than saying the wrong thing. An empty
 * field on a provider that does have the setting clears it, which is how a list is removed: absent and
 * empty are one answer, and the provider flow then falls back to its own default scope.
 */
export function buildAuthInstallationConfig(
  catalogEntry: PhiAuthProviderCatalogEntry,
  base: Record<string, unknown>,
  body: Record<string, unknown>,
): { config: Record<string, unknown> } | { error: string } {
  const config = { ...base };

  if (!catalogEntry.tenantMode && normalizeString(body.tenant)) {
    return { error: `${catalogEntry.label} installations take no tenant.` };
  }
  if (catalogEntry.tenantMode) {
    /*
     * A tenant-mode provider always carries one, because the issuer is derived from it. Absent on
     * create means `common`; absent on update means the one already stored stands.
     */
    const stated = body.tenant === undefined ? normalizeString(config.tenant) : normalizeString(body.tenant);
    config.tenant = (stated || "common").toLowerCase();
  }

  if (body.scopes !== undefined) {
    const scopes = readPhiAuthConfigList(body.scopes);
    if (!scopes) {
      return { error: "scopes must be a list of words or a separated string." };
    }
    if (scopes.length > 0) {
      config.scopes = scopes;
    } else {
      delete config.scopes;
    }
  }

  if (body.restrictions !== undefined) {
    const restrictions = readPhiAuthConfigList(body.restrictions);
    if (!restrictions) {
      return { error: "restrictions must be a list of words or a separated string." };
    }
    if (!catalogEntry.restrictionKey) {
      if (restrictions.length > 0) {
        return { error: `${catalogEntry.label} installations take no login restriction.` };
      }
    } else if (restrictions.length > 0) {
      config[catalogEntry.restrictionKey] = restrictions;
    } else {
      delete config[catalogEntry.restrictionKey];
    }
  }

  const prompt = normalizeString(body.prompt);
  if (body.prompt !== undefined) {
    if (!catalogEntry.promptMode) {
      if (prompt) {
        return { error: `${catalogEntry.label} installations take no prompt.` };
      }
    } else if (prompt) {
      config.prompt = prompt;
    } else {
      delete config.prompt;
    }
  }

  if (body.trustedEmailLink !== undefined) {
    if (typeof body.trustedEmailLink !== "boolean") {
      return { error: "trustedEmailLink must be a boolean." };
    }
    config.trustedEmailLink = body.trustedEmailLink;
  }

  return { config };
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
  const restrictionKey = catalogRestrictionKey(installation.providerKey);
  return {
    installationKey: installation.installationKey,
    providerKey: installation.providerKey,
    issuer: installation.issuer,
    clientId: installation.clientId,
    enabled: installation.enabled,
    tenant: typeof installation.config.tenant === "string" ? installation.config.tenant : null,
    /*
     * The config, in the shape the Admin Form edits it in: one field per setting, a list as the words
     * an operator typed. Serialized for every provider, `null` where the provider has no such setting,
     * so the row says "not applicable here" rather than "empty" -- the Form's own field is what decides
     * whether it is offered.
     */
    scopes: readPhiAuthConfigList(installation.config.scopes)?.join(" ") ?? "",
    restrictions: restrictionKey
      ? readPhiAuthConfigList(installation.config[restrictionKey])?.join(" ") ?? ""
      : null,
    prompt: typeof installation.config.prompt === "string" ? installation.config.prompt : null,
    trustedEmailLink: installation.config.trustedEmailLink === true,
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
