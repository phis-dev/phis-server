import { NextRequest, NextResponse } from "next/server";

import { createPendingTotpFactor } from "@/db/user-auth-factors";
import { getSessionFromRequest } from "@/db/user-sessions";
import { verifyCsrfRequest } from "@/lib/auth";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { PHI_AUTH_SESSION_STATES } from "@/lib/site-auth/contracts";
import { buildTotpUri } from "@/lib/site-auth/totp";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const siteContext = await requireSiteFromExplicitKeyRequest(request);
  if (siteContext.error || !siteContext.site) return siteContext.error;
  if (!verifyCsrfRequest(request)) {
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }
  const session = await getSessionFromRequest(request, siteContext.site.id, {
    allowIncomplete: true,
    allowPasswordChangeRequired: true,
  });
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (
    session.authState !== PHI_AUTH_SESSION_STATES.factorEnrollmentRequired &&
    session.authState !== PHI_AUTH_SESSION_STATES.complete
  ) {
    return NextResponse.json({ error: "TOTP enrollment is not available in this workflow." }, { status: 409 });
  }
  const factor = await createPendingTotpFactor({
    userId: session.userId,
    siteId: session.siteId,
  });
  return NextResponse.json({
    factorId: factor.id,
    manualKey: factor.manualKey,
    otpauthUri: buildTotpUri({
      manualKey: factor.manualKey,
      issuer: siteContext.site.name,
      accountName: `user-${session.userId}`,
    }),
  });
}
