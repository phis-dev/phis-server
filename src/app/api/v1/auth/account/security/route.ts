import { NextRequest, NextResponse } from "next/server";

import { getSiteAuthPolicy, listUserAuthIdentities } from "@/db/site-auth";
import { listUserAuthFactors } from "@/db/user-auth-factors";
import { getSessionFromRequest, listUserSessionsForSite } from "@/db/user-sessions";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

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
    listUserSessionsForSite(session.userId, session.siteId),
  ]);
  return NextResponse.json({
    policy: { factor: policy?.factorPolicy ?? null },
    factors: factors.filter((factor) => factor.type !== 3),
    identities,
    sessions,
    currentSessionId: session.id,
  });
}
