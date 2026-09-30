import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  ensureSiteMediaConfig,
  listAddonMediaSpaces,
  updateSiteMediaConfig,
  type SiteMediaConfigRecord,
  type SiteMediaConfigUpdate,
} from "@/db/media-spaces";
import { PhiSiteMediaFlags } from "@/lib/constants/media";
import { serializeMediaSpace } from "@/lib/media-response";
import { requireSiteDeveloperApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { requireJsonObjectBody } from "@/lib/helpers/request";

/**
 * Administrative surface for the effective per-Site Media policy.
 *
 * Media availability, default quotas, and the per-Space quota ceiling are Site settings, so this route
 * uses the Developer policy -- which the Core Admin override widens to Developer and Admin -- rather
 * than the wider Media management policy: Builder, Author, and Publisher manage Assets, not what the
 * Site enables.
 */
function serializeMediaConfig(config: SiteMediaConfigRecord) {
  return {
    userSpacesEnabled: (config.flags & PhiSiteMediaFlags.UserSpacesEnabled) !== 0,
    groupSpacesEnabled: (config.flags & PhiSiteMediaFlags.GroupSpacesEnabled) !== 0,
    defaultUserQuotaBytes: config.defaultUserQuotaBytes,
    defaultGroupQuotaBytes: config.defaultGroupQuotaBytes,
    maxUserQuotaBytes: config.maxUserQuotaBytes,
    maxGroupQuotaBytes: config.maxGroupQuotaBytes,
    defaultAddonQuotaBytes: config.defaultAddonQuotaBytes,
    maxAddonQuotaBytes: config.maxAddonQuotaBytes,
    maxObjectBytes: config.maxObjectBytes,
    // Read-only, like availability beside it: what a delegated Space accepts follows the active
    // Modules, because only a Module knows what its Space is for.
    userSpaceContentKinds: config.userSpaceContentKinds,
    groupSpaceContentKinds: config.groupSpaceContentKinds,
  };
}

function readOptionalQuota(value: unknown, field: string, issues: string[]) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    issues.push(`${field} must be null or a non-negative integer.`);
    return undefined;
  }
  return value;
}

/** Positive, because the schema's own check refuses anything else: every Site caps object size. */
function readObjectSize(value: unknown, issues: string[]) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    issues.push("maxObjectBytes must be a positive integer.");
    return undefined;
  }
  return value;
}

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteDeveloperApiContext(request);
  if (error) return error;
  const site = context!.site!;
  const config = await ensureSiteMediaConfig(site.id);
  const addonSpaces = await listAddonMediaSpaces(site.id);
  return NextResponse.json({
    media: serializeMediaConfig(config),
    /*
     * The Add-on Spaces this Site holds, so a Site default can be departed from for one of them.
     *
     * They appear here and nowhere else. An Add-on Space has no owner to administer it and is absent
     * from every Space listing on purpose, so without this an administrator could set the Site default
     * and nothing else -- the per-Space override on `PATCH /api/site/media/spaces/<id>` would be a route
     * whose address nobody could learn.
     */
    addonSpaces: addonSpaces.map(({ addonId, space }) => ({
      addonId,
      ...serializeMediaSpace(space, config),
    })),
  });
}

export async function PATCH(request: NextRequest) {
  const { context, error } = await requireSiteDeveloperApiContext(request);
  if (error) return error;
  const site = context!.site!;

  const parsedBody = await requireJsonObjectBody(request, "Invalid Media settings payload.");
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const { body } = parsedBody;

  const issues: string[] = [];
  // Availability is derived from what the Site's Modules declare, so it is reported here but never
  // administered here. Rejecting the field loudly is what keeps one truth: a Site that wants User or
  // Group Spaces activates a Module that needs them.
  for (const field of ["userSpacesEnabled", "groupSpacesEnabled"] as const) {
    if (body[field] !== undefined) {
      issues.push(`${field} is derived from the active Modules and cannot be set here.`);
    }
  }
  const update: SiteMediaConfigUpdate = {
    defaultUserQuotaBytes: readOptionalQuota(body.defaultUserQuotaBytes, "defaultUserQuotaBytes", issues),
    defaultGroupQuotaBytes: readOptionalQuota(body.defaultGroupQuotaBytes, "defaultGroupQuotaBytes", issues),
    // The ceiling a Space-level override may not exceed; `null` clears it back to no ceiling.
    maxUserQuotaBytes: readOptionalQuota(body.maxUserQuotaBytes, "maxUserQuotaBytes", issues),
    maxGroupQuotaBytes: readOptionalQuota(body.maxGroupQuotaBytes, "maxGroupQuotaBytes", issues),
    // The fourth kind on the same two rails. An Add-on's Space is not browsable and has no owner to
    // administer it, so without a Site default it would be the one delegated Space born unlimited.
    defaultAddonQuotaBytes: readOptionalQuota(body.defaultAddonQuotaBytes, "defaultAddonQuotaBytes", issues),
    maxAddonQuotaBytes: readOptionalQuota(body.maxAddonQuotaBytes, "maxAddonQuotaBytes", issues),
    // How much of it fits, which is capacity and therefore the operator's. What a Space accepts is not
    // here: it follows the Modules, because only a Module knows what its Space is for.
    maxObjectBytes: readObjectSize(body.maxObjectBytes, issues),
  };
  if (issues.length > 0) {
    return NextResponse.json({ error: "Invalid Media settings payload.", details: issues }, { status: 400 });
  }

  const media = await updateSiteMediaConfig(site.id, update);
  logRuntimeEvent("info", "admin.media.settings.updated", {
    siteKey: site.key,
    userId: context!.session!.userId,
    method: request.method,
    path: request.nextUrl.pathname,
    meta: serializeMediaConfig(media),
  });
  return NextResponse.json({ media: serializeMediaConfig(media) });
}
