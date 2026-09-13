import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { listSitePublishedPageAddresses } from "@/db/site-pages";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import { requireSiteFromRequest } from "@/lib/site-context";

/**
 * The published Public Pages of a Site, as the candidates its sitemap is built from.
 *
 * Public only, because Public is the only Area anything indexes -- and a list of the staff Areas'
 * addresses is exactly what the Site keeps out of its `robots.txt`. The endpoint is internal-token only
 * and answers addresses, never content: the Site resolves each one itself, so visibility, redirects and
 * `noindex` are decided by the same rules that decide a page view.
 */
export async function GET(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });

  const pages = await listSitePublishedPageAddresses(site.id, resolvePhisCmsAreaMask("public"));
  return NextResponse.json({ pages }, { headers: { "cache-control": "no-store" } });
}
