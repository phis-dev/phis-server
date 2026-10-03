import "server-only";

import type { NextRequest } from "next/server";

import { getSiteAuthPolicy, pickSiteAuthMethod, readSiteAuthSettings } from "@/db/site-auth";
import { hasConfirmedTotpFactor } from "@/db/user-auth-factors";
import {
  createUserSession,
  getSessionFromRequest,
  revokeUserSessionForSite,
  updateUserSessionAuthState,
} from "@/db/user-sessions";
import {
  PHI_AUTH_SESSION_STATES,
  type PhiAuthFactorPolicy,
  type PhiAuthSessionState,
} from "@/lib/site-auth/contracts";

function appliesToRoleScope(roleFlags: number, requiredRoleFlags: number) {
  return requiredRoleFlags === 0 || (roleFlags & requiredRoleFlags) !== 0;
}

/**
 * Whether the Site's factor policy asks this person for an authenticator at all.
 *
 * The policy names roles; no roles means everyone. Every place that enforces or protects the required
 * factor asks this one question, so a policy scoped to administrators cannot bind a Member in one
 * place and leave them free in another.
 */
export function siteFactorPolicyRequiresTotp(
  factorPolicy: Pick<PhiAuthFactorPolicy, "requiredMethod" | "roleFlags">,
  coreRoleFlags: number,
) {
  return (
    factorPolicy.requiredMethod === "totp" && appliesToRoleScope(coreRoleFlags, factorPolicy.roleFlags)
  );
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
  /** The Site's auth settings where the caller has just read them, so the row is not read again. */
  settings?: Awaited<ReturnType<typeof readSiteAuthSettings>>;
}) {
  // Policy and methods from one read of the row both live in.
  const settings = input.settings ?? await readSiteAuthSettings(input.siteId);
  const policy = settings.policy;
  if (!policy) {
    return { state: PHI_AUTH_SESSION_STATES.complete, policyRevision: 1, deferred: false } as const;
  }
  if (
    !siteFactorPolicyRequiresTotp(policy.factorPolicy, input.coreRoleFlags) ||
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
  const method = pickSiteAuthMethod(settings.methods, "totp", "second-factor");
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

/**
 * Starts the session a sign-in ends in, and ends the one the browser arrived with.
 *
 * The response overwrites the session cookie, but overwriting a cookie does not end the session it
 * named: a copy taken earlier would go on working until it expired. So a session the request carries
 * for this Site is revoked, whoever it belonged to, once the new one exists -- revoking first would
 * leave the browser signed out if creating the new one failed. Only a cookie whose secret verifies
 * counts; a forged or foreign one names nothing this browser may end.
 */
export async function beginSiteAuthenticationSession(input: {
  request: NextRequest;
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
  const previous = await getSessionFromRequest(input.request, input.siteId, {
    allowDisabled: true,
    allowIncomplete: true,
    allowPasswordChangeRequired: true,
  });
  if (previous) {
    await revokeUserSessionForSite({
      sessionId: previous.id,
      userId: previous.userId,
      siteId: input.siteId,
    });
  }
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
  const settings = await readSiteAuthSettings(input.siteId);
  const policy = settings.policy;
  if (!policy || policy.revision <= input.authPolicyRevision) {
    return PHI_AUTH_SESSION_STATES.complete;
  }
  const required = await resolveRequiredSessionState({
    settings,
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
