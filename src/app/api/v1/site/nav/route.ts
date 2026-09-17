import { NextRequest, NextResponse } from "next/server";

import {
  getPublishedSiteNavigationOverlay,
  getSiteNavigationOverlayRevisionById,
  projectSiteNavigationOverlayTargets,
} from "@/db/site-navigation";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteCmsPreviewApiContext } from "@/lib/guards/site-admin-api";
import { requireSiteFromRequest } from "@/lib/site-context";

export async function GET(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key")?.trim().toLowerCase() ?? "";
  const rawRevision = searchParams.get("revision")?.trim() ?? "";
  const rawReviewKind = searchParams.get("reviewKind")?.trim().toLowerCase() ?? "";
  const rawReviewRevision =
    rawReviewKind === "navigation" ? (searchParams.get("reviewRevision")?.trim() ?? "") : "";
  const rawEffectiveRevision = rawReviewRevision || rawRevision;
  const revisionId = rawEffectiveRevision.length > 0 ? Number(rawEffectiveRevision) : null;
  const hasRevision = revisionId != null && Number.isInteger(revisionId) && revisionId > 0;
  if (!key || !key.includes(":")) {
    return NextResponse.json({ error: "Missing nav key." }, { status: 400 });
  }
  if (rawEffectiveRevision.length > 0 && !hasRevision) {
    return NextResponse.json({ error: "Invalid nav revision." }, { status: 400 });
  }
  // Any stored revision may be a draft, so asking for one by id takes the same session a review does.
  // The internal token alone only proves the Site is asking, not that the visitor may see unpublished work.
  if (hasRevision) {
    const { error } = await requireSiteCmsPreviewApiContext(request);
    if (error) {
      return error;
    }
  }

  const overlay = hasRevision
    ? await getSiteNavigationOverlayRevisionById(site.id, key, revisionId as number)
    : await getPublishedSiteNavigationOverlay(site.id, key);
  if (!overlay) {
    return NextResponse.json({ error: "Navigation overlay not found." }, { status: 404 });
  }

  return createJsonResponse(request, {
    key,
    overlay: await projectSiteNavigationOverlayTargets(site.id, overlay),
  });
}
