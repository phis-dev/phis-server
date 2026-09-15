import { NextRequest, NextResponse } from "next/server";

import { resolvePublishedSiteNavigationFolderTarget } from "@/db/site-navigation";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";

/**
 * Where a folder address of an Area leads, as a Page reference, for the Site to answer a request that
 * found no Page with a 307. Asked on the miss path only; 404 when the address leads nowhere.
 */
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
  const area = searchParams.get("area")?.trim().toLowerCase() ?? "";
  const path = searchParams.get("path")?.trim() ?? "";
  if (!area || !path) {
    return NextResponse.json({ error: "area and path must be provided." }, { status: 400 });
  }

  const target = await resolvePublishedSiteNavigationFolderTarget(site.id, area, path);
  if (!target) {
    return NextResponse.json({ error: "Folder address not found." }, { status: 404 });
  }
  return NextResponse.json({ reference: target.reference }, { headers: { "Cache-Control": "no-store" } });
}
