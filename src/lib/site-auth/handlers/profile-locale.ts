import { NextRequest, NextResponse } from "next/server";

import { getSiteRuntimeConfig } from "@/db/sites";
import { updateUserAccountProfileFields } from "@/db/user-accounts";
import { setLocaleCookie } from "@/lib/auth";
import { resolveSiteLocale } from "@/lib/locale";
import { requireAuthenticatedSiteUser } from "@/lib/site-auth/authenticated-site-user";

type ProfileLocalePayload = {
  locale?: unknown;
};

export async function PATCH(request: NextRequest) {
  const guarded = await requireAuthenticatedSiteUser(request);
  if (!guarded.ok) return guarded.response;
  const { site, session, user } = guarded;

  let payload: ProfileLocalePayload = {};
  try {
    payload = (await request.json()) as ProfileLocalePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const config = await getSiteRuntimeConfig(site.id);
  if (!config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const availableLocales = config.availableLocales?.length
    ? config.availableLocales
    : [{ code: config.defaultLocale, label: config.defaultLocale }];
  const requestedLocale = typeof payload.locale === "string" ? payload.locale.trim() : "";
  const resolvedLocale = requestedLocale
    ? resolveSiteLocale({
        requestedLocale,
        defaultLocale: config.defaultLocale,
        availableLocales: availableLocales.map((option) => option.code),
      })
    : null;
  const preferredLocale = resolvedLocale?.source === "requested" ? resolvedLocale.locale : null;

  if (!preferredLocale) {
    return NextResponse.json({ error: "Unsupported locale." }, { status: 400 });
  }

  // The only write of `preferred_locale` there is. That is what makes its absence mean something: an
  // account whose column is `NULL` has never answered, and the language of the browser answers for it.
  const updated = await updateUserAccountProfileFields(user.id, {
    preferredLocale,
  });
  if (!updated) {
    return NextResponse.json({ error: "Failed to update locale." }, { status: 500 });
  }

  const response = NextResponse.json({
    preferredLocale,
  });
  setLocaleCookie(
    response,
    preferredLocale,
    session.expiresAt ? new Date(session.expiresAt) : undefined,
  );

  return response;
}
