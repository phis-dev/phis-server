import { NextRequest, NextResponse } from "next/server";

import { consumeRecoveryCode, verifyConfirmedTotpFactor } from "@/db/user-auth-factors";
import { getSessionFromRequest } from "@/db/user-sessions";
import { verifyCsrfRequest } from "@/lib/auth";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { checkAuthAttemptLimit, tooManyAttemptsResponse } from "@/lib/site-auth/attempt-limit";
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
  if (!session || session.authState !== PHI_AUTH_SESSION_STATES.factorChallengeRequired) {
    return NextResponse.json({ error: "Factor challenge required." }, { status: 409 });
  }
  // Six digits at the speed of the wire is an hour's work; ten a minute per challenge is not.
  const retryAfter = checkAuthAttemptLimit(request, [`verify:${session.id}`]);
  if (retryAfter !== null) {
    return tooManyAttemptsResponse(retryAfter);
  }
  let body: Record<string, unknown>;
  try { body = toPhiRecord(await request.json()); } catch { body = {}; }
  const methodKey = body.methodKey === "recovery-code" ? "recovery-code" : "totp";
  const valid = methodKey === "recovery-code"
    ? await consumeRecoveryCode({ userId: session.userId, siteId: session.siteId, code: body.code })
    : await verifyConfirmedTotpFactor({ userId: session.userId, siteId: session.siteId, code: body.code });
  if (!valid) {
    return NextResponse.json({ error: "Invalid authentication code." }, { status: 400 });
  }
  return createCompletedAuthWorkflowResponse({ session, methodKey });
}
