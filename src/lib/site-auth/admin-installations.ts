import "server-only";

import { NextResponse } from "next/server";

import {
  getSiteAuthMethod,
  getSiteAuthPolicy,
  listAuthProviderInstallations,
  upsertAuthProviderInstallation,
  upsertSiteAuthMethod,
} from "@/db/site-auth";
import { getSiteRuntimeConfig } from "@/db/sites";
import {
  deriveAuthInstallationIssuer,
  findAuthProviderCatalogEntry,
  listSerializedAuthInstallations,
  siteWouldRetainPrimaryLogin,
} from "@/lib/site-auth/installation-catalog";
import type { AuthAdminSectionContext } from "@/lib/site-auth/admin-sections";
import { buildSiteAuthSecretReference, writeSiteAuthSecret } from "@/lib/site-auth/secret-store";
import { normalizeString } from "@/lib/helpers/request";

/**
 * Shared update surface for one installation: the URL-addressed PATCH route and the
 * collection-level PATCH (installation key in the body, used by the Form relay whose upstream
 * path is static) both apply exactly this logic.
 */
export async function applyAuthInstallationPatch(
  context: AuthAdminSectionContext,
  installationKey: string,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const sitePublicUrl = (await getSiteRuntimeConfig(context.siteId))?.publicUrl;
  if (!sitePublicUrl) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }
  const existing = (await listAuthProviderInstallations(context.siteId))
    .find((entry) => entry.installationKey === installationKey);
  if (!existing) {
    return NextResponse.json({ error: "Unknown installation." }, { status: 404 });
  }
  const catalogEntry = findAuthProviderCatalogEntry(existing.providerKey);
  if (!catalogEntry) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }

  const clientId = body.clientId === undefined ? existing.clientId : normalizeString(body.clientId);
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required." }, { status: 400 });
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean." }, { status: 400 });
  }
  if (body.loginEnabled !== undefined && typeof body.loginEnabled !== "boolean") {
    return NextResponse.json({ error: "loginEnabled must be a boolean." }, { status: 400 });
  }
  const sortOrder = body.sortOrder === undefined || body.sortOrder === null ? undefined : body.sortOrder;
  if (sortOrder !== undefined && !Number.isSafeInteger(sortOrder)) {
    return NextResponse.json({ error: "sortOrder must be an integer." }, { status: 400 });
  }

  const config = { ...existing.config };
  if (catalogEntry.tenantMode && body.tenant !== undefined) {
    config.tenant = normalizeString(body.tenant).toLowerCase() || "common";
  }
  const issuer = deriveAuthInstallationIssuer(existing.providerKey, config);
  if (!issuer) {
    return NextResponse.json({ error: "Invalid provider tenant." }, { status: 400 });
  }

  let callbackOrigin = existing.callbackOrigin;
  if (body.callbackOrigin !== undefined) {
    const requestedOrigin = normalizeString(body.callbackOrigin);
    if (!requestedOrigin) {
      callbackOrigin = null;
    } else {
      const policy = await getSiteAuthPolicy(context.siteId);
      if (!policy?.allowedCallbackOrigins.includes(requestedOrigin)) {
        return NextResponse.json(
          { error: "callbackOrigin must be listed in the Site's allowedCallbackOrigins policy." },
          { status: 400 },
        );
      }
      callbackOrigin = requestedOrigin;
    }
  }

  const enabled = body.enabled === undefined ? existing.enabled : body.enabled === true;
  const currentMethod = await getSiteAuthMethod(
    context.siteId,
    existing.providerKey,
    "primary",
    installationKey,
  );
  const loginEnabled = body.loginEnabled === undefined
    ? currentMethod?.enabled ?? false
    : body.loginEnabled === true;

  if ((!enabled && existing.enabled) || (!loginEnabled && currentMethod?.enabled)) {
    const retains = await siteWouldRetainPrimaryLogin(context.siteId, {
      ...(enabled ? {} : { disabledInstallationKey: installationKey }),
      ...(loginEnabled ? {} : { disabledLoginInstallationKey: installationKey }),
    });
    if (!retains) {
      return NextResponse.json(
        { error: "This change would leave the site without any enabled login method." },
        { status: 409 },
      );
    }
  }

  let secretReference = existing.secretReference;
  const clientSecret = normalizeString(body.clientSecret);
  const configChanged = issuer !== existing.issuer || clientId !== existing.clientId;
  if (clientSecret) {
    secretReference = buildSiteAuthSecretReference(context.siteKey, installationKey);
    await writeSiteAuthSecret(secretReference, clientSecret, context.siteId);
  }

  await upsertAuthProviderInstallation({
    siteId: context.siteId,
    installationKey,
    providerKey: existing.providerKey,
    issuer,
    clientId,
    secretReference,
    config,
    enabled,
    callbackOrigin,
    // A credential or issuer change invalidates the last test result.
    validation: configChanged || clientSecret ? null : existing.validation,
  });
  await upsertSiteAuthMethod({
    siteId: context.siteId,
    methodKey: existing.providerKey,
    stage: "primary",
    providerInstallationKey: installationKey,
    enabled: loginEnabled,
    sortOrder: (sortOrder as number | undefined) ?? currentMethod?.sortOrder ?? 10,
    presentation: currentMethod?.presentation ?? { label: catalogEntry.label },
  });

  const installations = await listSerializedAuthInstallations(context.siteId, sitePublicUrl);
  return NextResponse.json({
    installation: installations.find((entry) => entry.installationKey === installationKey) ?? null,
  });
}
