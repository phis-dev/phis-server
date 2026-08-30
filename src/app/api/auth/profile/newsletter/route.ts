import { NextRequest, NextResponse } from "next/server";

import { getUserAccountById } from "@/db/user-accounts";
import { getEffectiveUserSiteAuthorization, setUserSiteFlags } from "@/db/user-site-memberships";
import { getSessionFromRequest } from "@/db/user-sessions";
import { verifyCsrfRequest } from "@/lib/auth";
import { requireSiteFromRequest } from "@/lib/site-context";
import { USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";

export const dynamic = "force-dynamic";

type NewsletterPayload = {
  newsletterOptIn?: unknown;
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

  let payload: NewsletterPayload = {};
  try {
    payload = (await request.json()) as NewsletterPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const newsletterOptIn = payload.newsletterOptIn === true;
  const nextFlags = newsletterOptIn
    ? siteRole.siteFlags | USER_SITE_FLAG_NEWSLETTER_OPT_IN
    : siteRole.siteFlags & ~USER_SITE_FLAG_NEWSLETTER_OPT_IN;

  const updated = await setUserSiteFlags(user.id, site.id, nextFlags);
  if (!updated) {
    return NextResponse.json({ error: "Failed to update newsletter preference." }, { status: 500 });
  }

  return NextResponse.json({
    newsletterOptIn: (updated.siteFlags & USER_SITE_FLAG_NEWSLETTER_OPT_IN) === USER_SITE_FLAG_NEWSLETTER_OPT_IN,
  });
}
