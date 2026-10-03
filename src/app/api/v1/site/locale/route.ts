import { NextRequest, NextResponse } from "next/server";

import { readSiteLocaleCodes } from "@/db/sites";
import { getUserAccountById } from "@/db/user-accounts";
import { getSessionFromRequest } from "@/db/user-sessions";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { LOCALE_COOKIE_NAME } from "@/lib/auth";
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

  // The locale codes and nothing else: the full runtime config also resolves the theme and the logos,
  // and this is asked on every page render.
  const availableLocales = await readSiteLocaleCodes(site.id);
  if (!availableLocales) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const session = await getSessionFromRequest(request, site.id, { allowPasswordChangeRequired: true });
  const user = session ? await getUserAccountById(session.userId) : null;
  const searchParams = new URL(request.url).searchParams;
  const explicitLocale = searchParams.get("locale") ?? request.headers.get("x-locale");
  const cookieLocale = request.cookies.get(LOCALE_COOKIE_NAME)?.value ?? null;
  const browserLocale = request.headers.get("accept-language");
  const resolvedLocale = resolveSiteLocale({
    requestedLocale: explicitLocale,
    // Absent for an account that has never answered the question: `preferred_locale` is written by the
    // profile save and by nothing else, so a value here is a choice and may outrank the cookie.
    userPreferredLocale: user?.preferredLocale ?? null,
    cookieLocale,
    browserLocale,
    defaultLocale: site.defaultLocale,
    availableLocales,
  });

  return createJsonResponse(request, {
    locale: resolvedLocale,
  });
}
