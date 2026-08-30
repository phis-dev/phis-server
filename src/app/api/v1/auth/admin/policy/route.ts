import { NextRequest, NextResponse } from "next/server";

import {
  buildAuthAdminSectionSettings,
  requireAuthAdminSectionContext,
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
  const { context, error } = await requireAuthAdminSectionContext(request);
  if (error || !context) {
    return error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid Auth policy payload." }, { status: 400 });
  }
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
