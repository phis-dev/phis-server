import { NextResponse } from "next/server";

import { ensureSiteMediaConfig, listAddonMediaSpaces } from "@/db/media-spaces";
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
  /*
   * The Add-on Spaces this Site holds, reported and not offered.
   *
   * They appear in no Space listing and have no owner, so an administrator would otherwise have no way
   * to learn that a store exists, what it is costing, or which Add-on to name when sizing one. What is
   * in them stays the Add-on's business; what they cost is the Site's.
   */
  const addonSpaces = await listAddonMediaSpaces(site.id);
  return createJsonResponse(request, {
    addonSpaces: addonSpaces.map(({ addonId, space }) => ({
      addonId,
      spaceId: space.id,
      usedBytes: space.usedBytes,
      reservedBytes: space.reservedBytes,
      quotaBytes: space.quotaBytes,
    })),
    media: {
      userSpacesEnabled: (config.flags & PhiSiteMediaFlags.UserSpacesEnabled) !== 0,
      groupSpacesEnabled: (config.flags & PhiSiteMediaFlags.GroupSpacesEnabled) !== 0,
      defaultUserQuotaBytes: config.defaultUserQuotaBytes,
      defaultGroupQuotaBytes: config.defaultGroupQuotaBytes,
      defaultAddonQuotaBytes: config.defaultAddonQuotaBytes,
      // The ceilings belong beside the defaults they bound. Without them the page can offer a default
      // it cannot show a limit for, and the limit is the half that refuses.
      maxUserQuotaBytes: config.maxUserQuotaBytes,
      maxGroupQuotaBytes: config.maxGroupQuotaBytes,
      maxAddonQuotaBytes: config.maxAddonQuotaBytes,
      maxObjectBytes: config.maxObjectBytes,
      userSpaceContentKinds: config.userSpaceContentKinds,
      groupSpaceContentKinds: config.groupSpaceContentKinds,
    },
  });
}
