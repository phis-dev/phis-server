import { NextRequest, NextResponse } from "next/server";

import { listSiteAuthMethods, upsertSiteAuthMethod } from "@/db/site-auth";
import {
  buildAuthAdminSectionSettings,
  requireAuthAdminSectionContext,
} from "@/lib/site-auth/admin-sections";
import { siteWouldRetainPrimaryLogin } from "@/lib/site-auth/installation-catalog";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Flat section endpoint for the primary password login method. Accepts exactly the Settings
 * Form values; the method's presentation carries over unchanged.
 */
export async function PATCH(request: NextRequest) {
  const { context, error } = await requireAuthAdminSectionContext(request);
  if (error || !context) {
    return error ?? NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid password method payload." }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean." }, { status: 400 });
  }
  const sortOrder = body.sortOrder == null ? 0 : body.sortOrder;
  if (!Number.isSafeInteger(sortOrder)) {
    return NextResponse.json({ error: "sortOrder must be an integer." }, { status: 400 });
  }

  const current = (await listSiteAuthMethods(context.siteId)).find(
    (method) => method.methodKey === "password" && method.stage === "primary",
  );
  if (!body.enabled && current?.enabled) {
    const retains = await siteWouldRetainPrimaryLogin(context.siteId, { disablePasswordMethod: true });
    if (!retains) {
      return NextResponse.json(
        { error: "This change would leave the site without any enabled login method." },
        { status: 409 },
      );
    }
  }
  await upsertSiteAuthMethod({
    siteId: context.siteId,
    methodKey: "password",
    stage: "primary",
    providerInstallationKey: null,
    enabled: body.enabled,
    sortOrder: sortOrder as number,
    presentation: current?.presentation ?? {},
  });
  logRuntimeEvent("info", "auth.admin.password-method.updated", {
    siteKey: context.siteKey,
    userId: context.userId,
    method: request.method,
    path: request.nextUrl.pathname,
  });

  const settings = await buildAuthAdminSectionSettings(context.siteId);
  return NextResponse.json({ passwordMethod: settings.passwordMethod });
}
