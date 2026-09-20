import { NextRequest, NextResponse } from "next/server";

import { readPhiViewerAddonRoleClaims } from "@/lib/addons/viewer-roles";
import { getUserAccountById } from "@/db/user-accounts";
import { getUserProfileByUserId } from "@/db/user-profiles";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import { getSessionFromRequest, touchSession } from "@/db/user-sessions";
import { requireSiteFromRequest } from "@/lib/site-context";
import { resolvePhiUserArea } from "@/lib/user-area";
import { USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";
import { resolveUserThemeModeName } from "@/lib/user-flags";

function buildDisplayName(input: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}) {
  const fullName = [input.firstName?.trim() ?? "", input.lastName?.trim() ?? ""]
    .filter(Boolean)
    .join(" ")
    .trim();
  return fullName || input.email;
}

export async function GET(request: NextRequest) {
  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });
  }

  const session = await getSessionFromRequest(request, site.id);
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const user = await getUserAccountById(session.userId, site.id);
  if (!user || !user.siteIds.includes(site.id)) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  const siteRole = await getEffectiveUserSiteAuthorization(user.id, site.id);
  if (!siteRole.enabled) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  await touchSession(session.id, request);

  let name = user.emailNormalized;
  const profile = await getUserProfileByUserId(user.id);
  if (profile) {
    name = buildDisplayName({
      email: user.emailNormalized,
      firstName: profile.firstName,
      lastName: profile.lastName,
    });
  }

  return NextResponse.json({
    authenticated: true,
    area: resolvePhiUserArea({
      authenticated: true,
      roleClaims: siteRole.roleClaims,
    }),
    user: {
      id: user.id,
      email: user.emailNormalized,
      name,
      roleClaims: siteRole.roleClaims,
      groupClaims: siteRole.groupClaims,
      addonRoleClaims: await readPhiViewerAddonRoleClaims(site.id, user.id),
      authorizationRevision: siteRole.authorizationRevision,
      newsletterOptIn: (siteRole.siteFlags & USER_SITE_FLAG_NEWSLETTER_OPT_IN) === USER_SITE_FLAG_NEWSLETTER_OPT_IN,
      preferredLocale: user.preferredLocale ?? site.defaultLocale,
      /*
       * Unlike the locale, this is not resolved here. A Site has a default language and can answer for
       * somebody who never said; nobody but the browser can answer "system", so the absence of a choice
       * travels as `system` and is resolved where `prefers-color-scheme` is known.
       */
      themeMode: resolveUserThemeModeName(user.flags),
      authentication: {
        authenticatedAt: session.authenticatedAt,
        assuranceLevel: session.assuranceLevel,
        methodKeys: session.authMethodKeys,
      },
      profile: profile
        ? {
            firstName: profile.firstName,
            lastName: profile.lastName,
            companyName: profile.companyName,
          }
        : null,
      site: {
        id: site.id,
        key: site.key,
      },
    },
  });
}
