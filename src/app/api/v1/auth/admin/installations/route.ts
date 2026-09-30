import { NextRequest, NextResponse } from "next/server";

import {
  listAuthProviderInstallations,
  upsertAuthProviderInstallation,
  upsertSiteAuthMethod,
} from "@/db/site-auth";
import { getSiteRuntimeConfig } from "@/db/sites";
import {
  PHI_AUTH_PROVIDER_CATALOG,
  buildAuthInstallationConfig,
  deriveAuthInstallationIssuer,
  findAuthProviderCatalogEntry,
  listSerializedAuthInstallations,
  normalizeAuthInstallationKey,
} from "@/lib/site-auth/installation-catalog";
import { applyAuthInstallationPatch } from "@/lib/site-auth/admin-installations";
import {
  requireAuthAdminSectionContext,
  requireAuthAdminSectionReadContext,
  requireAuthAdminSectionWrite,
} from "@/lib/site-auth/admin-sections";
import { buildSiteAuthSecretReference, writeSiteAuthSecret } from "@/lib/site-auth/secret-store";
import { logRuntimeEvent } from "@/lib/log";
import { normalizeString, requireJsonObjectBody } from "@/lib/helpers/request";
import { getSiteAuthPolicy } from "@/db/site-auth";

export const dynamic = "force-dynamic";

async function resolveSitePublicUrl(siteId: number) {
  return (await getSiteRuntimeConfig(siteId))?.publicUrl ?? null;
}

export async function GET(request: NextRequest) {
  const { context, error } = await requireAuthAdminSectionReadContext(request);
  if (error || !context) {
    return error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const sitePublicUrl = await resolveSitePublicUrl(context.siteId);
  if (!sitePublicUrl) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }
  return NextResponse.json({
    installations: await listSerializedAuthInstallations(context.siteId, sitePublicUrl),
    providerCatalog: PHI_AUTH_PROVIDER_CATALOG,
  });
}

export async function POST(request: NextRequest) {
  const { context, error } = await requireAuthAdminSectionContext(request);
  if (error || !context) {
    return error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const sitePublicUrl = await resolveSitePublicUrl(context.siteId);
  if (!sitePublicUrl) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const parsedBody = await requireJsonObjectBody(request, "Invalid installation payload.");
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const { body } = parsedBody;
  const installationKey = normalizeAuthInstallationKey(body.installationKey);
  if (!installationKey) {
    return NextResponse.json({ error: "installationKey must be a lowercase slug." }, { status: 400 });
  }
  const catalogEntry = findAuthProviderCatalogEntry(normalizeString(body.providerKey));
  if (!catalogEntry) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }
  const clientId = normalizeString(body.clientId);
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required." }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean." }, { status: 400 });
  }
  const existing = await listAuthProviderInstallations(context.siteId);
  if (existing.some((entry) => entry.installationKey === installationKey)) {
    return NextResponse.json({ error: "installationKey is already in use." }, { status: 409 });
  }

  const configResult = buildAuthInstallationConfig(catalogEntry, {}, body);
  if ("error" in configResult) {
    return NextResponse.json({ error: configResult.error }, { status: 400 });
  }
  const { config } = configResult;
  const issuer = deriveAuthInstallationIssuer(catalogEntry.providerKey, config);
  if (!issuer) {
    return NextResponse.json({ error: "Invalid provider tenant." }, { status: 400 });
  }

  let callbackOrigin: string | null = null;
  if (body.callbackOrigin != null && normalizeString(body.callbackOrigin)) {
    const requestedOrigin = normalizeString(body.callbackOrigin);
    const policy = await getSiteAuthPolicy(context.siteId);
    if (!policy?.allowedCallbackOrigins.includes(requestedOrigin)) {
      return NextResponse.json(
        { error: "callbackOrigin must be listed in the Site's allowedCallbackOrigins policy." },
        { status: 400 },
      );
    }
    callbackOrigin = requestedOrigin;
  }

  let secretReference: string | null = null;
  const clientSecret = normalizeString(body.clientSecret);
  if (clientSecret) {
    secretReference = buildSiteAuthSecretReference(context.siteKey, installationKey);
    await writeSiteAuthSecret(secretReference, clientSecret, context.siteId);
  }

  await upsertAuthProviderInstallation({
    siteId: context.siteId,
    installationKey,
    providerKey: catalogEntry.providerKey,
    issuer,
    clientId,
    secretReference,
    config,
    enabled: body.enabled,
    callbackOrigin,
    validation: null,
  });
  await upsertSiteAuthMethod({
    siteId: context.siteId,
    methodKey: catalogEntry.providerKey,
    stage: "primary",
    providerInstallationKey: installationKey,
    enabled: false,
    sortOrder: 10,
    presentation: { label: catalogEntry.label },
  });
  logRuntimeEvent("info", "auth.admin.installation.created", {
    siteKey: context.siteKey,
    userId: context.userId,
    method: request.method,
    path: request.nextUrl.pathname,
    meta: { installationKey, providerKey: catalogEntry.providerKey },
  });

  const installations = await listSerializedAuthInstallations(context.siteId, sitePublicUrl);
  return NextResponse.json({
    installation: installations.find((entry) => entry.installationKey === installationKey) ?? null,
  }, { status: 201 });
}

/**
 * Collection-level update used by the descriptor Form relay (its upstream path is static): the
 * installation key travels in the body; the applied logic is identical to the URL-addressed
 * PATCH route.
 */
export async function PATCH(request: NextRequest) {
  const guarded = await requireAuthAdminSectionWrite(request, "Invalid installation payload.");
  if (!guarded.ok) {
    return guarded.response;
  }
  const { context, body } = guarded;
  const installationKey = normalizeAuthInstallationKey(body.installationKey);
  if (!installationKey) {
    return NextResponse.json({ error: "Unknown installation." }, { status: 404 });
  }
  const response = await applyAuthInstallationPatch(context, installationKey, body);
  if (response.ok) {
    logRuntimeEvent("info", "auth.admin.installation.updated", {
      siteKey: context.siteKey,
      userId: context.userId,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: { installationKey },
    });
  }
  return response;
}
