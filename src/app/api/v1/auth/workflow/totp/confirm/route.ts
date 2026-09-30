import { NextRequest, NextResponse } from "next/server";

import { confirmPendingTotpFactor } from "@/db/user-auth-factors";
import { getSessionFromRequest } from "@/db/user-sessions";
import { verifyCsrfRequest } from "@/lib/auth";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { PHI_AUTH_SESSION_STATES } from "@/lib/site-auth/contracts";
import { createCompletedAuthWorkflowResponse } from "@/lib/site-auth/workflow";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";
import { toPhiRecord } from "@/lib/helpers/record";

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
  let body: Record<string, unknown>;
  try { body = toPhiRecord(await request.json()); } catch { body = {}; }
  const factorId = typeof body.factorId === "string" ? body.factorId : "";
  const confirmed = await confirmPendingTotpFactor({
    factorId,
    userId: session.userId,
    siteId: session.siteId,
    code: body.code,
  });
  if (!confirmed) {
    return NextResponse.json({ error: "Invalid authenticator code." }, { status: 400 });
  }
  if (session.authState === PHI_AUTH_SESSION_STATES.factorEnrollmentRequired) {
    return createCompletedAuthWorkflowResponse({
      session,
      methodKey: "totp",
      recoveryCodes: confirmed.recoveryCodes,
    });
  }
  return NextResponse.json({ complete: false, recoveryCodes: confirmed.recoveryCodes });
}
