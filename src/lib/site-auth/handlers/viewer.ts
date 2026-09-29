import { NextRequest, NextResponse } from "next/server";

import { readPhiViewerAddonRoleClaims } from "@/lib/addons/viewer-roles";
import { getSiteRuntimeConfig } from "@/db/sites";
import { getUserAccountById } from "@/db/user-accounts";
import { getUserProfileByUserId } from "@/db/user-profiles";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import { getSessionFromRequest, touchSession } from "@/db/user-sessions";
import { resolveSignedInLocale } from "@/lib/auth";
import { requireSiteFromRequest } from "@/lib/site-context";
import { resolvePhiUserArea } from "@/lib/user-area";
import { USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";
import { resolveUserThemeModeName, USER_ACCOUNT_FLAG_MUST_CHANGE_PASSWORD } from "@/lib/user-flags";

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

  const session = await getSessionFromRequest(request, site.id, { allowPasswordChangeRequired: true });
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
  const runtimeConfig = await getSiteRuntimeConfig(site.id);
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

  const mustChangePassword = (user.flags & USER_ACCOUNT_FLAG_MUST_CHANGE_PASSWORD) !== 0;
  return NextResponse.json({
    authenticated: true,
    area: resolvePhiUserArea({
      authenticated: true,
      roleClaims: siteRole.roleClaims,
      accountFlags: user.flags,
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
      /*
       * The language this person is being served, which is their saved choice where they made one and
       * otherwise what this request resolves to. Not the raw column: that also holds the seed
       * registration or an admin screen wrote, and handing that out made the Language panel show English
       * under a page rendered in German -- an answer the person had never given, offered back to them as
       * if they had.
       */
      preferredLocale: resolveSignedInLocale(request, {
        user,
        defaultLocale: runtimeConfig?.defaultLocale ?? site.defaultLocale,
        availableLocales: runtimeConfig?.availableLocales.map((option) => option.code)
          ?? [site.defaultLocale],
      }),
      /*
       * Unlike the locale, this is not resolved here. A Site has a default language and can answer for
       * somebody who never said; nobody but the browser can answer "system", so the absence of a choice
       * travels as `system` and is resolved where `prefers-color-scheme` is known.
       */
      themeMode: resolveUserThemeModeName(user.flags),
      /*
       * The one thing this session may still do. Every other API refuses it (`getSessionFromRequest`),
       * and the Site shows the password change in front of whatever page was asked for.
       */
      mustChangePassword,
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
