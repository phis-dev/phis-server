import { NextRequest, NextResponse } from "next/server";

import { getSiteAuthPolicy } from "@/db/site-auth";
import { deleteUserAuthFactor, listUserAuthFactors, PHI_AUTH_FACTOR_TYPES } from "@/db/user-auth-factors";
import { getSessionFromRequest } from "@/db/user-sessions";
import { verifyCsrfRequest } from "@/lib/auth";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ factorId: string }> };

export async function DELETE(request: NextRequest, context: Context) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const siteContext = await requireSiteFromExplicitKeyRequest(request);
  if (siteContext.error || !siteContext.site) return siteContext.error;
  if (!verifyCsrfRequest(request)) {
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }
  const session = await getSessionFromRequest(request, siteContext.site.id);
  if (!session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const factorId = (await context.params).factorId;
  const [policy, factors] = await Promise.all([
    getSiteAuthPolicy(session.siteId),
    listUserAuthFactors(session.userId, session.siteId),
  ]);
  const factor = factors.find((entry) => entry.id === factorId);
  if (!factor) {
    return NextResponse.json({ error: "Authentication factor not found." }, { status: 404 });
  }
  if (
    factor.type === PHI_AUTH_FACTOR_TYPES.totp &&
    policy?.factorPolicy.requiredMethod === "totp" &&
    factors.filter((entry) => entry.type === PHI_AUTH_FACTOR_TYPES.totp && entry.confirmedAt).length <= 1
  ) {
    return NextResponse.json(
      { error: "The required authenticator factor cannot be removed." },
      { status: 409 },
    );
  }
  const removed = await deleteUserAuthFactor({
    factorId,
    userId: session.userId,
    siteId: session.siteId,
  });
  return NextResponse.json({ ok: removed });
}
