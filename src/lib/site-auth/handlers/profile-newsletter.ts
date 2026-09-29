import { NextRequest, NextResponse } from "next/server";

import { changeUserSiteFlags } from "@/db/user-site-memberships";
import { USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";
import { requireAuthenticatedSiteUser } from "@/lib/site-auth/authenticated-site-user";

type NewsletterPayload = {
  newsletterOptIn?: unknown;
};

export async function PATCH(request: NextRequest) {
  const guarded = await requireAuthenticatedSiteUser(request);
  if (!guarded.ok) return guarded.response;
  const { site, user } = guarded;

  let payload: NewsletterPayload = {};
  try {
    payload = (await request.json()) as NewsletterPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const newsletterOptIn = payload.newsletterOptIn === true;
  const updated = await changeUserSiteFlags(
    user.id,
    site.id,
    newsletterOptIn
      ? { set: USER_SITE_FLAG_NEWSLETTER_OPT_IN }
      : { clear: USER_SITE_FLAG_NEWSLETTER_OPT_IN },
  );
  if (!updated) {
    return NextResponse.json({ error: "Failed to update newsletter preference." }, { status: 500 });
  }

  return NextResponse.json({
    newsletterOptIn: (updated.siteFlags & USER_SITE_FLAG_NEWSLETTER_OPT_IN) === USER_SITE_FLAG_NEWSLETTER_OPT_IN,
  });
}
