import { NextRequest, NextResponse } from "next/server";

import { getSessionFromRequest } from "@/db/user-sessions";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { PHI_AUTH_SESSION_STATES } from "@/lib/site-auth/contracts";
import { serializeAuthWorkflow } from "@/lib/site-auth/workflow";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const siteContext = await requireSiteFromExplicitKeyRequest(request);
  if (siteContext.error || !siteContext.site) return siteContext.error;
  const session = await getSessionFromRequest(request, siteContext.site.id, {
    allowIncomplete: true,
  });
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: session.authState === PHI_AUTH_SESSION_STATES.complete,
    workflow: serializeAuthWorkflow(session),
  });
}
