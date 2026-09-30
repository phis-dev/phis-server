import { NextRequest, NextResponse } from "next/server";

import {
  buildAuthAdminSectionSettings,
  requireAuthAdminSectionWrite,
  updateSiteAuthPolicySections,
} from "@/lib/site-auth/admin-sections";
import {
  isPhiAuthLinkingMode,
  isPhiAuthRegistrationMode,
} from "@/lib/site-auth/contracts";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Flat section endpoint for the Auth Admin registration/linking policy. Accepts exactly the
 * Settings Form values; every other policy field carries over unchanged.
 */
export async function PATCH(request: NextRequest) {
  const guarded = await requireAuthAdminSectionWrite(request, "Invalid Auth policy payload.");
  if (!guarded.ok) {
    return guarded.response;
  }
  const { context, body } = guarded;
  if (!isPhiAuthRegistrationMode(body.registrationMode) || !isPhiAuthLinkingMode(body.existingAccountLinking)) {
    return NextResponse.json({ error: "Invalid authentication policy mode." }, { status: 400 });
  }
  if (typeof body.allowPrivilegedAutoLink !== "boolean") {
    return NextResponse.json({ error: "allowPrivilegedAutoLink must be a boolean." }, { status: 400 });
  }

  await updateSiteAuthPolicySections(context.siteId, {
    registrationMode: body.registrationMode,
    existingAccountLinking: body.existingAccountLinking,
    allowPrivilegedAutoLink: body.allowPrivilegedAutoLink,
  });
  logRuntimeEvent("info", "auth.admin.policy.updated", {
    siteKey: context.siteKey,
    userId: context.userId,
    method: request.method,
    path: request.nextUrl.pathname,
  });

  const settings = await buildAuthAdminSectionSettings(context.siteId);
  return NextResponse.json({ policy: settings.policy });
}
