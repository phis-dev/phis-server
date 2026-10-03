import { NextRequest, NextResponse } from "next/server";

import {
  type SiteAuthPolicy,
  getSiteAuthPolicy,
  readSiteAuthSettings,
  upsertSiteAuthPolicy,
} from "@/db/site-auth";
import { verifyCsrfRequest } from "@/lib/auth";
import { requireSiteAdminOnlyApiContext } from "@/lib/guards/site-admin-api";
import { requireJsonObjectBody } from "@/lib/helpers/request";
import { readPhiBaseRoleKeys } from "@/lib/constants/phi-base-roles";

export type AuthAdminSectionContext = {
  siteId: number;
  siteKey: string;
  userId: number;
};

/**
 * Who may reach an Auth Admin section at all: a Site-Admin session, and nothing further.
 *
 * This is the whole guard for a read. A CSRF token defends a state change against a request the user
 * never meant to make; a read makes no change, and who may see it is already decided above. Asking a
 * listing for one would mean fetching a token before every load for no gain -- and the listing did not
 * ask, which is why it answered 403 instead of showing the installations.
 */
export async function requireAuthAdminSectionReadContext(
  request: NextRequest,
): Promise<{ context: AuthAdminSectionContext | null; error: NextResponse | null }> {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error || !context?.site || !context.session) {
    return {
      context: null,
      error: error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    };
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
 * Shared guard for the flat Auth Admin section endpoints: the read guard plus CSRF. The section
 * endpoints accept exactly the flat Form values of one Settings section and own every derivation
 * server-side (SETTINGS.md section 6, AUTHENTICATION.md section 8).
 *
 * Every endpoint that writes uses this one. A GET uses the read guard above; reaching for this one
 * because it is the familiar name is what gated the installations listing behind a token no read sends.
 */
export async function requireAuthAdminSectionContext(
  request: NextRequest,
): Promise<{ context: AuthAdminSectionContext | null; error: NextResponse | null }> {
  const { context, error } = await requireAuthAdminSectionReadContext(request);
  if (error || !context) {
    return { context: null, error };
  }
  if (!verifyCsrfRequest(request)) {
    return { context: null, error: NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 }) };
  }
  return { context, error: null };
}

/**
 * The write guard and the section's JSON object body, in the order every section PATCH checked them.
 *
 * The flat section endpoints each opened with the same eight lines around their own payload wording;
 * the wording is still the endpoint's to give.
 */
export async function requireAuthAdminSectionWrite(request: NextRequest, invalidPayloadError: string) {
  const { context, error } = await requireAuthAdminSectionContext(request);
  if (error || !context) {
    return {
      ok: false as const,
      response: error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    };
  }
  const parsedBody = await requireJsonObjectBody(request, invalidPayloadError);
  if (!parsedBody.ok) {
    return parsedBody;
  }
  return { ok: true as const, context, body: parsedBody.body };
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
  const { policy, methods } = await readSiteAuthSettings(siteId);
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
