import { NextRequest, NextResponse } from "next/server";

import { getSiteRuntimeConfig, updateSiteSettings, type SiteRuntimeConfig } from "@/db/sites";
import { getSiteConfigBySiteId } from "@/db/site-config";
import { requireSiteAdminOnlyApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { normalizeString, readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function buildSettingsResponse(
  site: {
    id: number;
    key: string;
    name: string;
  },
  runtime: SiteRuntimeConfig,
  config: NonNullable<Awaited<ReturnType<typeof getSiteConfigBySiteId>>>,
) {
  return {
    site: {
      key: site.key,
      name: runtime.name,
      hostname: runtime.hostname,
      publicBaseUrl: config.publicBaseUrl,
      supportEmail: config.supportEmail,
      mailFrom: config.mailFrom,
      mailFromName: config.mailFromName,
      contactRecipient: config.contactRecipient,
      defaultLocale: runtime.defaultLocale,
      availableLocales: runtime.availableLocales,
    },
  };
}

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  const site = context.site;

  const [runtime, config] = await Promise.all([
    getSiteRuntimeConfig(site.id),
    getSiteConfigBySiteId(site.id),
  ]);
  if (!runtime || !config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  return NextResponse.json(buildSettingsResponse(site, runtime, config));
}

export async function PATCH(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  const site = context.site;

  const body = await readRequestBody(request);

  const [runtime, config] = await Promise.all([
    getSiteRuntimeConfig(site.id),
    getSiteConfigBySiteId(site.id),
  ]);
  if (!runtime || !config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const name = normalizeString(body.name) || runtime.name;
  const hostname = normalizeString(body.hostname) || runtime.hostname;
  const publicBaseUrl = normalizeString(body.publicBaseUrl) || config.publicBaseUrl;
  const supportEmail = normalizeString(body.supportEmail) || config.supportEmail;

  try {
    await updateSiteSettings({
      id: site.id,
      name,
      hostname,
      publicBaseUrl,
      defaultLocale: runtime.defaultLocale,
      availableLocales: runtime.availableLocales.map((option) => option.code),
      supportEmail,
    });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Site update failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const [updatedRuntime, updatedConfig] = await Promise.all([
    getSiteRuntimeConfig(site.id),
    getSiteConfigBySiteId(site.id),
  ]);
  if (!updatedRuntime || !updatedConfig) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.settings.updated", {
    area: "admin",
    message: "Site settings updated.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: {
      hostname: updatedRuntime.hostname,
      publicBaseUrl: updatedConfig.publicBaseUrl,
    },
  });

  return NextResponse.json(buildSettingsResponse(site, updatedRuntime, updatedConfig));
}
