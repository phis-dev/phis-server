import { NextResponse } from "next/server";

import { ensureSiteMediaConfig } from "@/db/media-spaces";
import { PhiSiteMediaFlags } from "@/lib/constants/media";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * Internal read of the Site's Media configuration for server-side composition (the Admin Media
 * Settings page loads its Form initial values here). Mutations stay on the session-guarded
 * /api/site/admin/media route; this endpoint is internal-token read-only.
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

  const config = await ensureSiteMediaConfig(site.id);
  return createJsonResponse(request, {
    media: {
      userSpacesEnabled: (config.flags & PhiSiteMediaFlags.UserSpacesEnabled) !== 0,
      groupSpacesEnabled: (config.flags & PhiSiteMediaFlags.GroupSpacesEnabled) !== 0,
      defaultUserQuotaBytes: config.defaultUserQuotaBytes,
      defaultGroupQuotaBytes: config.defaultGroupQuotaBytes,
      maxObjectBytes: config.maxObjectBytes,
      userSpaceContentKinds: config.userSpaceContentKinds,
      groupSpaceContentKinds: config.groupSpaceContentKinds,
    },
  });
}
