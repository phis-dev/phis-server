import "server-only";

import { NextResponse } from "next/server";

import { getEffectiveUserSiteAuthorization, recordUserSiteLogin } from "@/db/user-site-memberships";
import type { getSessionFromRequest } from "@/db/user-sessions";
import { setAreaCookie } from "@/lib/auth";
import { completeSiteAuthenticationSession } from "@/lib/site-auth/assurance";
import { PHI_AUTH_SESSION_STATES } from "@/lib/site-auth/contracts";
import { resolvePhiUserArea } from "@/lib/user-area";

export type AuthWorkflowSession = NonNullable<Awaited<ReturnType<typeof getSessionFromRequest>>>;

export function serializeAuthWorkflow(session: AuthWorkflowSession) {
  const state = session.authState === PHI_AUTH_SESSION_STATES.factorEnrollmentRequired
    ? "factor-enrollment-required"
    : session.authState === PHI_AUTH_SESSION_STATES.factorChallengeRequired
      ? "factor-challenge-required"
      : "complete";
  return {
    state,
    methodKey: state === "complete" ? null : "totp",
    next: session.nextPath,
  } as const;
}

export async function createCompletedAuthWorkflowResponse(input: {
  session: AuthWorkflowSession;
  methodKey: "totp" | "recovery-code";
  recoveryCodes?: string[];
}) {
  const authorization = await getEffectiveUserSiteAuthorization(
    input.session.userId,
    input.session.siteId,
  );
  if (!authorization.enabled) {
    return NextResponse.json({ error: "Site access disabled." }, { status: 403 });
  }
  await completeSiteAuthenticationSession({
    sessionId: input.session.id,
    siteId: input.session.siteId,
    userId: input.session.userId,
    coreRoleFlags: authorization.coreRoleFlags,
    authMethodKeys: input.session.authMethodKeys,
    completedMethodKey: input.methodKey,
  });
  await recordUserSiteLogin(input.session.userId, input.session.siteId);
  const area = resolvePhiUserArea({ authenticated: true, roleClaims: authorization.roleClaims });
  const response = NextResponse.json({
    complete: true,
    area,
    next: input.session.nextPath,
    ...(input.recoveryCodes ? { recoveryCodes: input.recoveryCodes } : {}),
  });
  if (input.session.expiresAt) {
    setAreaCookie(response, area, new Date(input.session.expiresAt));
  }
  return response;
}
