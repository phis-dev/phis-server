import { NextRequest, NextResponse } from "next/server";

import { listSiteNavigationScopes } from "@/db/site-navigation";
import { guardApiV1 } from "@/lib/api-v1-guard";
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

  const area = request.nextUrl.searchParams.get("area");
  const scopes = await listSiteNavigationScopes(site.id, area);
  return NextResponse.json({
    scopes: scopes.map((scope) => ({
      key: scope.key,
      label: scope.label,
      hasPublishedRevision: scope.publishedRevisionId != null,
      hasWorkingDraftRevision: scope.workingDraftRevisionId != null,
    })),
  });
}
