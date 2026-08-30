import { NextRequest, NextResponse } from "next/server";

import { consumeRecoveryCode, verifyConfirmedTotpFactor } from "@/db/user-auth-factors";
import { getSessionFromRequest } from "@/db/user-sessions";
import { verifyCsrfRequest } from "@/lib/auth";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { PHI_AUTH_SESSION_STATES } from "@/lib/site-auth/contracts";
import { createCompletedAuthWorkflowResponse } from "@/lib/site-auth/workflow";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

function toRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

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
  });
  if (!session || session.authState !== PHI_AUTH_SESSION_STATES.factorChallengeRequired) {
    return NextResponse.json({ error: "Factor challenge required." }, { status: 409 });
  }
  let body: Record<string, unknown>;
  try { body = toRecord(await request.json()); } catch { body = {}; }
  const methodKey = body.methodKey === "recovery-code" ? "recovery-code" : "totp";
  const valid = methodKey === "recovery-code"
    ? await consumeRecoveryCode({ userId: session.userId, siteId: session.siteId, code: body.code })
    : await verifyConfirmedTotpFactor({ userId: session.userId, siteId: session.siteId, code: body.code });
  if (!valid) {
    return NextResponse.json({ error: "Invalid authentication code." }, { status: 400 });
  }
  return createCompletedAuthWorkflowResponse({ session, methodKey });
}
