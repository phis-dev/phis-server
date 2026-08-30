import { NextResponse } from "next/server";

import { getSiteRuntimeConfig } from "@/db/sites";
import { getSiteConfigBySiteId } from "@/db/site-config";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * Internal read of the Site's Admin settings surface for server-side composition (the Admin
 * Settings General page loads its Form initial values here). Mutations stay on the
 * session-guarded /api/site/admin/settings route; this endpoint is internal-token read-only.
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

  const [runtime, config] = await Promise.all([
    getSiteRuntimeConfig(site.id),
    getSiteConfigBySiteId(site.id),
  ]);
  if (!runtime || !config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  return createJsonResponse(request, {
    settings: {
      key: site.key,
      name: runtime.name,
      hostname: runtime.hostname,
      publicBaseUrl: config.publicBaseUrl,
      supportEmail: config.supportEmail,
      mailFrom: config.mailFrom,
      mailFromName: config.mailFromName,
      contactRecipient: config.contactRecipient,
    },
  });
}
