import { NextRequest, NextResponse } from "next/server";

import { getSiteThemeRevisionReview, normalizeSiteThemeScopeKey } from "@/db/site-theme";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteCmsPreviewApiContext } from "@/lib/guards/site-admin-api";
import { requireSiteFromRequest } from "@/lib/site-context";
import { readSiteCmsRevisionId } from "@/lib/helpers/site-cms-route";

export async function GET(request: NextRequest) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const url = new URL(request.url);
  const key = normalizeSiteThemeScopeKey(url.searchParams.get("key"));
  const revisionValue = url.searchParams.get("revision");
  if (!revisionValue) {
    return NextResponse.json({ error: "revision is required." }, { status: 400 });
  }

  const revisionId = readSiteCmsRevisionId(revisionValue);
  if (revisionId == null) {
    return NextResponse.json({ error: "revision must be a positive integer." }, { status: 400 });
  }

  const { context, error } = await requireSiteCmsPreviewApiContext(request);
  if (error) {
    return error;
  }

  const review = await getSiteThemeRevisionReview(context!.site!.id, revisionId, { key });
  if (!review) {
    return NextResponse.json({ error: "Theme revision not found." }, { status: 404 });
  }

  return createJsonResponse(request, {
    key,
    revisionId,
    theme: review.theme,
  });
}
