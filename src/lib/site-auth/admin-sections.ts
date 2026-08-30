import { NextRequest, NextResponse } from "next/server";

import {
  getSiteAuthPolicy,
  listSiteAuthMethods,
  upsertSiteAuthPolicy,
  type SiteAuthPolicy,
} from "@/db/site-auth";
import { verifyCsrfRequest } from "@/lib/auth";
import { requireSiteAdminOnlyApiContext } from "@/lib/guards/site-admin-api";
import { readPhiBaseRoleKeys } from "@/lib/constants/phi-base-roles";

export type AuthAdminSectionContext = {
  siteId: number;
  siteKey: string;
  userId: number;
};

/**
 * Shared guard for the flat Auth Admin section endpoints: Site-Admin session plus CSRF. The
 * section endpoints accept exactly the flat Form values of one Settings section and own every
 * derivation server-side (SETTINGS.md section 6, AUTHENTICATION.md section 8).
 */
export async function requireAuthAdminSectionContext(
  request: NextRequest,
): Promise<{ context: AuthAdminSectionContext | null; error: NextResponse | null }> {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error || !context?.site || !context.session) {
    return {
      context: null,
      error: error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    };
  }
  if (!verifyCsrfRequest(request)) {
    return { context: null, error: NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 }) };
  }
  return {
    context: {
      siteId: context.site.id,
      siteKey: context.site.key,
      userId: context.session.userId,
    },
    error: null,
  };
}

/**
 * Applies a partial policy change on top of the persisted policy. All untouched policy fields
 * carry over; a missing persisted policy starts from the platform's neutral defaults.
 */
export async function updateSiteAuthPolicySections(
  siteId: number,
  change: Partial<Omit<SiteAuthPolicy, "siteId" | "revision">>,
) {
  const current = await getSiteAuthPolicy(siteId);
  await upsertSiteAuthPolicy({
    siteId,
    registrationMode: change.registrationMode ?? current?.registrationMode ?? "disabled",
    existingAccountLinking:
      change.existingAccountLinking ?? current?.existingAccountLinking ?? "verified-email-confirm",
    allowPrivilegedAutoLink:
      change.allowPrivilegedAutoLink ?? current?.allowPrivilegedAutoLink ?? false,
    passwordPolicy: change.passwordPolicy ?? current?.passwordPolicy ?? {},
    passkeyPolicy: change.passkeyPolicy ?? current?.passkeyPolicy ?? {},
    factorPolicy: change.factorPolicy ?? current?.factorPolicy ?? {
      requiredMethod: null,
      enforcement: "next-login",
      graceUntil: null,
      roleFlags: 0,
    },
    recoveryPolicy: change.recoveryPolicy ?? current?.recoveryPolicy ?? {},
    sessionPolicy: change.sessionPolicy ?? current?.sessionPolicy ?? {},
    allowedCallbackOrigins: change.allowedCallbackOrigins ?? current?.allowedCallbackOrigins ?? [],
  });
}

export async function buildAuthAdminSectionSettings(siteId: number) {
  const [policy, methods] = await Promise.all([
    getSiteAuthPolicy(siteId),
    listSiteAuthMethods(siteId),
  ]);
  const passwordMethod = methods.find(
    (method) => method.methodKey === "password" && method.stage === "primary",
  );
  const factorPolicy = policy?.factorPolicy ?? null;
  return {
    policy: {
      registrationMode: policy?.registrationMode ?? "disabled",
      existingAccountLinking: policy?.existingAccountLinking ?? "verified-email-confirm",
      allowPrivilegedAutoLink: policy?.allowPrivilegedAutoLink ?? false,
    },
    passwordMethod: {
      enabled: passwordMethod?.enabled ?? false,
      sortOrder: passwordMethod?.sortOrder ?? 0,
    },
    totpPolicy: {
      required: factorPolicy?.requiredMethod === "totp",
      enforcement: factorPolicy?.enforcement ?? "next-login",
      graceUntil: factorPolicy?.graceUntil ?? null,
      roles: readPhiBaseRoleKeys(factorPolicy?.roleFlags ?? 0),
    },
  };
}
