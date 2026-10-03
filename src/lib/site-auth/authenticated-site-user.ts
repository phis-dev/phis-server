import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getSiteRequestActorFromRequest } from "@/db/site-request-actor";
import { verifyCsrfRequest } from "@/lib/auth";
import { requireSiteFromRequest } from "@/lib/site-context";

/**
 * The first two links on their own, for the writes that come before any session exists: sign-in and
 * the password reset. They stood hand-written in each of those handlers, next to the same pair inside
 * the signed-in chain below.
 *
 * A CSRF refusal still carries the Site it was refused for, so a handler that logs the attempt can name
 * it; a missing Site carries nothing to name.
 */
export async function requireCsrfCheckedSite(request: NextRequest) {
  const site = await requireSiteFromRequest(request);
  if (!site) {
    return refuse(NextResponse.json({ error: "Missing site context." }, { status: 400 }));
  }
  if (!verifyCsrfRequest(request)) {
    return { ...refuse(NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 })), site };
  }
  return { ok: true as const, site };
}

/**
 * The chain every signed-in write under `/api/v1/auth` starts with: a Site, the CSRF token, a session
 * for that Site, an account that belongs to it, and a membership that is enabled.
 *
 * It stood word for word in six handlers, and a copy is where a check goes missing -- the password
 * method and the reset CSRF check were both absent from exactly such copies. One chain, one place to
 * add the next link.
 */
export async function requireAuthenticatedSiteUser(
  request: NextRequest,
  /** Only the password change itself: an account told to change its password may do that and no more. */
  options: { allowPasswordChangeRequired?: boolean } = {},
) {
  const checked = await requireCsrfCheckedSite(request);
  if (!checked.ok) {
    return refuse(checked.response);
  }
  const { site } = checked;
  // Session, account and authorization from one statement (`getSiteRequestActorFromRequest`).
  const actor = await getSiteRequestActorFromRequest(request, site.id, {
    allowPasswordChangeRequired: options.allowPasswordChangeRequired,
    account: { externalSiteId: 0 },
  });
  if (!actor) {
    return refuse(unauthorized());
  }
  const { session, user, siteRole } = actor;
  if (!user || !user.siteIds.includes(site.id)) {
    return refuse(unauthorized());
  }
  if (!siteRole.enabled) {
    return refuse(unauthorized());
  }
  return { ok: true as const, site, session, user, siteRole };
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

function refuse(response: NextResponse) {
  return { ok: false as const, response };
}
