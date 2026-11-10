import { NextResponse } from "next/server";

import { getSiteRuntimeConfig } from "@/db/sites";
import {
  PHI_AUTH_PROVIDER_CATALOG,
  listSerializedAuthInstallations,
} from "@/lib/site-auth/installation-catalog";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * Internal read of the Site's provider installations for server-side composition. Secrets never
 * leave the store; the payload carries only the configured/missing status. Mutations stay on the
 * session-guarded /api/v1/auth/admin/installations endpoints.
 */
export async function GET(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }
  const runtime = await getSiteRuntimeConfig(site.id);
  if (!runtime) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  return createJsonResponse(request, {
    installations: await listSerializedAuthInstallations(site.id, runtime.publicUrl),
    providerCatalog: PHI_AUTH_PROVIDER_CATALOG,
  });
}
