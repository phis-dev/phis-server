import "server-only";

import { phiUserEmailSourceForProvider } from "@phis/contracts/access";

import { getUserAccountByEmail, getUserAccountById, ensureUserAccount } from "@/db/user-accounts";
import {
  getSiteAuthPolicy,
  getUserIdByExternalIdentity,
  linkExternalIdentity,
} from "@/db/site-auth";
import { getUserSiteMembership, upsertUserSiteMembership } from "@/db/user-site-memberships";
import { PHI_CORE_ROLE_PROVIDER_ID } from "@/lib/authorization";
import { PhiBaseRole } from "@/lib/constants/phi-base-roles";
import { decideExternalAccountResolution } from "@/lib/site-auth/account-linking";
import { isUserAccountEnabled } from "@/lib/user-flags";

export type ValidatedExternalIdentity = {
  issuer: string;
  subject: string;
  providerKey: string;
  email: string | null;
  emailVerified: boolean;
};

export type ExternalLoginResolution =
  | { ok: true; userId: number; linked: boolean; created: boolean }
  | { ok: false; code: "link_required"; userId: number }
  | {
      ok: false;
      code:
        | "account_disabled"
        | "membership_required"
        | "registration_disabled"
        | "verified_email_required";
    };

export async function resolveExternalLogin(input: {
  siteId: number;
  identity: ValidatedExternalIdentity;
  trustedForAutoLink: boolean;
}): Promise<ExternalLoginResolution> {
  const policy = await getSiteAuthPolicy(input.siteId);
  if (!policy) {
    return { ok: false, code: "registration_disabled" };
  }

  const identityUserId = await getUserIdByExternalIdentity(
    input.identity.issuer,
    input.identity.subject,
  );
  const emailUser = input.identity.email && input.identity.emailVerified
    ? await getUserAccountByEmail(input.identity.email, input.siteId)
    : null;
  const candidateUserId = identityUserId ?? emailUser?.id ?? null;
  const [candidateUser, membership] = candidateUserId
    ? await Promise.all([
        getUserAccountById(candidateUserId, input.siteId),
        getUserSiteMembership(candidateUserId, input.siteId),
      ])
    : [null, null];
  const privileged = Boolean(
    membership?.roleClaims.some(
      (claim) => claim.providerId === PHI_CORE_ROLE_PROVIDER_ID &&
        (claim.flags & PhiBaseRole.Admin) === PhiBaseRole.Admin,
    ),
  );

  const decision = decideExternalAccountResolution({
    identityUserId,
    emailUserId: emailUser?.id ?? null,
    hasMembership: Boolean(membership),
    accountEnabled: candidateUser ? isUserAccountEnabled(candidateUser.flags) && (membership?.enabled ?? true) : true,
    emailVerified: input.identity.emailVerified && Boolean(input.identity.email),
    registrationMode: policy.registrationMode,
    linkingMode: policy.existingAccountLinking,
    trustedForAutoLink: input.trustedForAutoLink,
    privileged,
    allowPrivilegedAutoLink: policy.allowPrivilegedAutoLink,
  });

  if (decision === "account-disabled") {
    return { ok: false, code: "account_disabled" };
  }
  if (decision === "link-required") {
    if (!candidateUserId) {
      return { ok: false, code: "verified_email_required" };
    }
    return { ok: false, code: "link_required", userId: candidateUserId };
  }
  if (decision === "membership-required") {
    return { ok: false, code: "membership_required" };
  }
  if (decision === "registration-disabled") {
    return { ok: false, code: "registration_disabled" };
  }
  if (decision === "verified-email-required") {
    return { ok: false, code: "verified_email_required" };
  }

  if (decision === "use-linked-user" && identityUserId) {
    if (!membership) {
      await upsertUserSiteMembership({ userId: identityUserId, siteId: input.siteId });
    }
    return { ok: true, userId: identityUserId, linked: true, created: false };
  }

  let userId = emailUser?.id ?? null;
  let created = false;
  if (decision === "create-user") {
    const createdUser = await ensureUserAccount({
      email: input.identity.email!,
      siteId: input.siteId,
      emailSource: phiUserEmailSourceForProvider(input.identity.providerKey),
      preferredLocale: null,
      flags: 0,
      reuseExisting: false,
    });
    userId = createdUser.id;
    created = true;
  } else if (decision === "link-existing-user" && userId && !membership) {
    await upsertUserSiteMembership({ userId, siteId: input.siteId });
  }

  if (!userId) {
    return { ok: false, code: "verified_email_required" };
  }

  await linkExternalIdentity({
    userId,
    issuer: input.identity.issuer,
    subject: input.identity.subject,
    providerKey: input.identity.providerKey,
  });
  return { ok: true, userId, linked: !created, created };
}
