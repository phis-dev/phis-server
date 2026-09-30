import { NextRequest, NextResponse } from "next/server";

import {
  countSiteUserIdentitiesByIssuer,
  deleteAuthProviderInstallation,
  listAuthProviderInstallations,
} from "@/db/site-auth";
import {
  normalizeAuthInstallationKey,
  siteWouldRetainPrimaryLogin,
} from "@/lib/site-auth/installation-catalog";
import { applyAuthInstallationPatch } from "@/lib/site-auth/admin-installations";
import { requireAuthAdminSectionContext } from "@/lib/site-auth/admin-sections";
import { deleteSiteAuthSecret } from "@/lib/site-auth/secret-store";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ installationKey: string }> };

export async function PATCH(request: NextRequest, routeContext: Context) {
  const { context, error } = await requireAuthAdminSectionContext(request);
  if (error || !context) {
    return error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const installationKey = normalizeAuthInstallationKey((await routeContext.params).installationKey);
  if (!installationKey) {
    return NextResponse.json({ error: "Unknown installation." }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid installation payload." }, { status: 400 });
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

export async function DELETE(request: NextRequest, routeContext: Context) {
  const { context, error } = await requireAuthAdminSectionContext(request);
  if (error || !context) {
    return error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const installationKey = normalizeAuthInstallationKey((await routeContext.params).installationKey);
  if (!installationKey) {
    return NextResponse.json({ error: "Unknown installation." }, { status: 404 });
  }
  const existing = (await listAuthProviderInstallations(context.siteId))
    .find((entry) => entry.installationKey === installationKey);
  if (!existing) {
    return NextResponse.json({ error: "Unknown installation." }, { status: 404 });
  }

  const retains = await siteWouldRetainPrimaryLogin(context.siteId, {
    removedInstallationKey: installationKey,
  });
  if (!retains) {
    return NextResponse.json(
      { error: "Deleting this installation would leave the site without any enabled login method." },
      { status: 409 },
    );
  }

  const linkedIdentities = await countSiteUserIdentitiesByIssuer(context.siteId, existing.issuer);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.confirm !== true) {
    return NextResponse.json(
      {
        error: "Deleting an installation requires confirmation.",
        requiresConfirmation: true,
        linkedIdentities,
      },
      { status: 409 },
    );
  }

  await deleteAuthProviderInstallation(context.siteId, installationKey);
  if (existing.secretReference) {
    await deleteSiteAuthSecret(existing.secretReference);
  }
  logRuntimeEvent("info", "auth.admin.installation.deleted", {
    siteKey: context.siteKey,
    userId: context.userId,
    method: request.method,
    path: request.nextUrl.pathname,
    meta: { installationKey, providerKey: existing.providerKey, linkedIdentities },
  });
  return NextResponse.json({ deleted: true, linkedIdentities });
}
