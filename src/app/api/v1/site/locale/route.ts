import { NextRequest, NextResponse } from "next/server";

import { getSiteRuntimeConfig } from "@/db/sites";
import { getUserAccountById } from "@/db/user-accounts";
import { getSessionFromRequest } from "@/db/user-sessions";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { resolveSiteLocale } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const config = await getSiteRuntimeConfig(site.id);
  if (!config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const session = await getSessionFromRequest(request, site.id);
  const user = session ? await getUserAccountById(session.userId) : null;
  const searchParams = new URL(request.url).searchParams;
  const explicitLocale = searchParams.get("locale") ?? request.headers.get("x-locale");
  const cookieLocale = request.cookies.get("phi_locale")?.value ?? null;
  const browserLocale = request.headers.get("accept-language");
  const resolvedLocale = resolveSiteLocale({
    requestedLocale: explicitLocale,
    userPreferredLocale: user?.preferredLocale ?? null,
    cookieLocale,
    browserLocale,
    defaultLocale: config.defaultLocale,
    availableLocales: config.availableLocales.map((option) => option.code),
  });

  return createJsonResponse(request, {
    locale: resolvedLocale,
  });
}
