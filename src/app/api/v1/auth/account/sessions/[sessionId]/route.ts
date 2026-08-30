import { NextRequest, NextResponse } from "next/server";

import { getSessionFromRequest, revokeUserSessionForSite } from "@/db/user-sessions";
import { verifyCsrfRequest } from "@/lib/auth";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ sessionId: string }> };

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
  const targetSessionId = (await context.params).sessionId;
  if (targetSessionId === session.id) {
    return NextResponse.json(
      { error: "Use logout to revoke the current session." },
      { status: 409 },
    );
  }
  const revoked = await revokeUserSessionForSite({
    sessionId: targetSessionId,
    userId: session.userId,
    siteId: session.siteId,
  });
  if (!revoked) {
    return NextResponse.json({ error: "Active session not found." }, { status: 404 });
  }
  return NextResponse.json({});
}
