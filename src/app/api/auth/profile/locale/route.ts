import { NextRequest, NextResponse } from "next/server";

import { getSiteRuntimeConfig } from "@/db/sites";
import { getUserAccountById, updateUserAccountProfileFields } from "@/db/user-accounts";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import { getSessionFromRequest } from "@/db/user-sessions";
import { requireSiteFromRequest } from "@/lib/site-context";
import { verifyCsrfRequest } from "@/lib/auth";
import { resolveSiteLocale } from "@/lib/locale";

export const dynamic = "force-dynamic";

type ProfileLocalePayload = {
  locale?: unknown;
};

export async function PATCH(request: NextRequest) {
  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });
  }

  if (!verifyCsrfRequest(request)) {
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }

  const session = await getSessionFromRequest(request, site.id);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const user = await getUserAccountById(session.userId);
  if (!user || !user.siteIds.includes(site.id)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const siteRole = await getEffectiveUserSiteAuthorization(user.id, site.id);
  if (!siteRole.enabled) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

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

  const updated = await updateUserAccountProfileFields(user.id, {
    preferredLocale,
  });
  if (!updated) {
    return NextResponse.json({ error: "Failed to update locale." }, { status: 500 });
  }

  const response = NextResponse.json({
    preferredLocale,
  });
  response.cookies.set("phi_locale", preferredLocale, {
    path: "/",
    sameSite: "lax",
    ...(session.expiresAt ? { expires: new Date(session.expiresAt) } : {}),
  });

  return response;
}
