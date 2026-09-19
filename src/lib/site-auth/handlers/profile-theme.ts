import { NextRequest, NextResponse } from "next/server";

import { getUserAccountById, updateUserAccountProfileFields } from "@/db/user-accounts";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import { getSessionFromRequest } from "@/db/user-sessions";
import { requireSiteFromRequest } from "@/lib/site-context";
import { setThemeModeCookie, verifyCsrfRequest } from "@/lib/auth";
import {
  phiUserThemeModeFromName,
  phiUserThemeModeName,
} from "@phis/contracts/access";

type ProfileThemePayload = {
  themeMode?: unknown;
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

  let payload: ProfileThemePayload = {};
  try {
    payload = (await request.json()) as ProfileThemePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  /*
   * `system` stores `null`, so the reading cannot lean on the value alone: `undefined` is the name that
   * is not one of the three, and it is refused rather than stored as "follow the browser", which would
   * look like the person had asked for it.
   */
  const requestedThemeMode = phiUserThemeModeFromName(payload.themeMode);
  if (requestedThemeMode === undefined) {
    return NextResponse.json({ error: "Unsupported theme mode." }, { status: 400 });
  }

  const updated = await updateUserAccountProfileFields(user.id, {
    themeMode: requestedThemeMode,
  });
  if (!updated) {
    return NextResponse.json({ error: "Failed to update theme mode." }, { status: 500 });
  }

  const themeMode = phiUserThemeModeName(updated.themeMode);
  const response = NextResponse.json({ themeMode });
  setThemeModeCookie(
    response,
    themeMode,
    session.expiresAt ? new Date(session.expiresAt) : undefined,
  );

  return response;
}
