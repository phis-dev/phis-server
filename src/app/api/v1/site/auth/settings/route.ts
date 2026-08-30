import { NextResponse } from "next/server";

import { buildAuthAdminSectionSettings } from "@/lib/site-auth/admin-sections";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * Internal read of the Auth Admin section values for server-side composition (the Admin
 * Authentication Settings page loads its Form initial values here). Contains no provider
 * installations and no secrets; mutations stay on the session-guarded section endpoints.
 */
export async function GET(request: Request) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  return createJsonResponse(request, {
    auth: await buildAuthAdminSectionSettings(site.id),
  });
}
