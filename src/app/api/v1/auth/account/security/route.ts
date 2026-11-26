import { NextRequest, NextResponse } from "next/server";

import { getSiteAuthPolicy, listUserAuthIdentities } from "@/db/site-auth";
import { listUserAuthFactors } from "@/db/user-auth-factors";
import { getSessionFromRequest, listLiveUserSessionsForSite } from "@/db/user-sessions";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * The signed-in account's own security: the Site's factor policy, its factors, linked identities and live sessions (neither revoked nor expired) -- the login history is for the Site Admin and the Site Maintainer, not the account.
 */
export async function GET(request: NextRequest) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const siteContext = await requireSiteFromExplicitKeyRequest(request);
  if (siteContext.error || !siteContext.site) return siteContext.error;
  const session = await getSessionFromRequest(request, siteContext.site.id);
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const [policy, factors, identities, sessions] = await Promise.all([
    getSiteAuthPolicy(siteContext.site.id),
    listUserAuthFactors(session.userId, session.siteId),
    listUserAuthIdentities(session.userId),
    listLiveUserSessionsForSite(session.userId, session.siteId),
  ]);
  return NextResponse.json({
    policy: { factor: policy?.factorPolicy ?? null },
    factors: factors.filter((factor) => factor.type !== 3),
    identities,
    sessions,
    currentSessionId: session.id,
  });
}
