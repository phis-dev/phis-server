import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { buildPhisCapabilitySnapshot } from "@/lib/addons/capability-snapshot";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";

export async function GET(request: NextRequest) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  return createJsonResponse(
    request,
    {
      siteKey: site.key,
      ...(await buildPhisCapabilitySnapshot(site.id)),
    },
    {
      cacheControl: "private, no-store",
    },
  );
}
