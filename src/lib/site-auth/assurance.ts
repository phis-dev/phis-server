import "server-only";

import { getSiteAuthMethod, getSiteAuthPolicy } from "@/db/site-auth";
import { hasConfirmedTotpFactor } from "@/db/user-auth-factors";
import { createUserSession, updateUserSessionAuthState } from "@/db/user-sessions";
import {
  PHI_AUTH_SESSION_STATES,
  type PhiAuthSessionState,
} from "@/lib/site-auth/contracts";

function appliesToRoleScope(roleFlags: number, requiredRoleFlags: number) {
  return requiredRoleFlags === 0 || (roleFlags & requiredRoleFlags) !== 0;
}

function enforcementIsActive(input: {
  enforcement: "next-login" | "immediate" | "grace";
  graceUntil: string | null;
  login: boolean;
}) {
  if (input.login || input.enforcement === "immediate") return true;
  if (input.enforcement === "next-login") return false;
  return Boolean(input.graceUntil && new Date(input.graceUntil).getTime() <= Date.now());
}

/**
 * A grace deadline that has not passed yet, for a session it will apply to once it has.
 *
 * Such a session is complete for now and not for good. The reevaluation must not record the policy
 * revision it checked against, or the revisions are equal the moment the deadline passes and nothing
 * looks at the session again until its owner signs in anew -- up to the session's full lifetime.
 */
function isDeferredByGrace(policy: { enforcement: string; graceUntil: string | null }) {
  return (
    policy.enforcement === "grace" &&
    Boolean(policy.graceUntil && new Date(policy.graceUntil).getTime() > Date.now())
  );
}

export async function resolveRequiredSessionState(input: {
  siteId: number;
  userId: number;
  coreRoleFlags: number;
  authMethodKeys: readonly string[];
  login: boolean;
}) {
  const policy = await getSiteAuthPolicy(input.siteId);
  if (!policy) {
    return { state: PHI_AUTH_SESSION_STATES.complete, policyRevision: 1, deferred: false } as const;
  }
  const required = policy.factorPolicy.requiredMethod;
  if (
    required !== "totp" ||
    !appliesToRoleScope(input.coreRoleFlags, policy.factorPolicy.roleFlags) ||
    input.authMethodKeys.includes("totp")
  ) {
    return {
      state: PHI_AUTH_SESSION_STATES.complete,
      policyRevision: policy.revision,
      deferred: false,
    } as const;
  }
  if (!enforcementIsActive({
    enforcement: policy.factorPolicy.enforcement,
    graceUntil: policy.factorPolicy.graceUntil,
    login: input.login,
  })) {
    return {
      state: PHI_AUTH_SESSION_STATES.complete,
      policyRevision: policy.revision,
      deferred: isDeferredByGrace(policy.factorPolicy),
    } as const;
  }
  const method = await getSiteAuthMethod(input.siteId, "totp", "second-factor");
  if (!method?.enabled) {
    throw new Error("AUTH_REQUIRED_FACTOR_UNAVAILABLE");
  }
  const enrolled = await hasConfirmedTotpFactor(input.userId, input.siteId);
  return {
    state: enrolled
      ? PHI_AUTH_SESSION_STATES.factorChallengeRequired
      : PHI_AUTH_SESSION_STATES.factorEnrollmentRequired,
    policyRevision: policy.revision,
    deferred: false,
  } as const;
}

export async function beginSiteAuthenticationSession(input: {
  userId: number;
  siteId: number;
  coreRoleFlags: number;
  authMethodKeys: string[];
  nextPath: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const required = await resolveRequiredSessionState({
    siteId: input.siteId,
    userId: input.userId,
    coreRoleFlags: input.coreRoleFlags,
    authMethodKeys: input.authMethodKeys,
    login: true,
  });
  const session = await createUserSession({
    userId: input.userId,
    siteId: input.siteId,
    assuranceLevel: required.state === PHI_AUTH_SESSION_STATES.complete ? 1 : 0,
    authState: required.state,
    authPolicyRevision: required.policyRevision,
    authMethodKeys: input.authMethodKeys,
    nextPath: input.nextPath,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
  return { ...session, authState: required.state, policyRevision: required.policyRevision };
}

export async function completeSiteAuthenticationSession(input: {
  sessionId: string;
  siteId: number;
  userId: number;
  coreRoleFlags: number;
  authMethodKeys: readonly string[];
  completedMethodKey: "totp" | "recovery-code";
}) {
  const policy = await getSiteAuthPolicy(input.siteId);
  const policyRevision = policy?.revision ?? 1;
  await updateUserSessionAuthState({
    sessionId: input.sessionId,
    authState: PHI_AUTH_SESSION_STATES.complete,
    authPolicyRevision: policyRevision,
    assuranceLevel: 2,
    authMethodKey: input.completedMethodKey,
  });
  return { state: PHI_AUTH_SESSION_STATES.complete, policyRevision } as const;
}

export async function reevaluateCompleteSession(input: {
  sessionId: string;
  siteId: number;
  userId: number;
  coreRoleFlags: number;
  authMethodKeys: readonly string[];
  authPolicyRevision: number;
}) {
  const policy = await getSiteAuthPolicy(input.siteId);
  if (!policy || policy.revision <= input.authPolicyRevision) {
    return PHI_AUTH_SESSION_STATES.complete;
  }
  const required = await resolveRequiredSessionState({
    siteId: input.siteId,
    userId: input.userId,
    coreRoleFlags: input.coreRoleFlags,
    authMethodKeys: input.authMethodKeys,
    login: false,
  });
  if (required.deferred) {
    // Asked again on the next request, and on every one after it, until the deadline has passed.
    return required.state;
  }
  await updateUserSessionAuthState({
    sessionId: input.sessionId,
    authState: required.state,
    authPolicyRevision: required.policyRevision,
  });
  return required.state as PhiAuthSessionState;
}
