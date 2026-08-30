import { NextRequest, NextResponse } from "next/server";

import {
  listSiteAuthMethods,
  parseSiteAuthFactorPolicy,
  upsertSiteAuthMethod,
} from "@/db/site-auth";
import {
  buildAuthAdminSectionSettings,
  requireAuthAdminSectionContext,
  updateSiteAuthPolicySections,
} from "@/lib/site-auth/admin-sections";
import { buildPhiBaseRoleFlags } from "@/lib/constants/phi-base-roles";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Flat section endpoint for the two-factor (TOTP) policy. Accepts exactly the Settings Form
 * values; the role bitmask, the grace clearing, and the required-policy/method coupling are
 * derived server-side.
 */
export async function PATCH(request: NextRequest) {
  const { context, error } = await requireAuthAdminSectionContext(request);
  if (error || !context) {
    return error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid TOTP policy payload." }, { status: 400 });
  }
  if (typeof body.required !== "boolean") {
    return NextResponse.json({ error: "required must be a boolean." }, { status: 400 });
  }
  const roles = body.roles == null ? [] : body.roles;
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string")) {
    return NextResponse.json({ error: "roles must be a list of role keys." }, { status: 400 });
  }
  const roleFlags = buildPhiBaseRoleFlags(roles as string[]);
  if (roleFlags === null) {
    return NextResponse.json({ error: "roles contains an unknown role key." }, { status: 400 });
  }

  let factorPolicy;
  try {
    factorPolicy = parseSiteAuthFactorPolicy({
      requiredMethod: body.required ? "totp" : null,
      enforcement: body.enforcement ?? "next-login",
      graceUntil: body.enforcement === "grace" ? body.graceUntil ?? null : null,
      roleFlags,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Invalid TOTP policy.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const currentTotp = (await listSiteAuthMethods(context.siteId)).find(
    (method) => method.methodKey === "totp" && method.stage === "second-factor",
  );
  await upsertSiteAuthMethod({
    siteId: context.siteId,
    methodKey: "totp",
    stage: "second-factor",
    providerInstallationKey: null,
    enabled: body.required || currentTotp?.enabled === true,
    sortOrder: currentTotp?.sortOrder ?? 10,
    presentation: currentTotp?.presentation ?? { label: "Authenticator app" },
  });
  await updateSiteAuthPolicySections(context.siteId, { factorPolicy });
  logRuntimeEvent("info", "auth.admin.totp-policy.updated", {
    siteKey: context.siteKey,
    userId: context.userId,
    method: request.method,
    path: request.nextUrl.pathname,
  });

  const settings = await buildAuthAdminSectionSettings(context.siteId);
  return NextResponse.json({ totpPolicy: settings.totpPolicy });
}
