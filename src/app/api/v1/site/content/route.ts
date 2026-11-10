import { NextRequest, NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { normalizeLocale } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";
import { handleSiteWidgetContentRead } from "@/lib/site-content-route";

/*
 * The bound content of Widgets by instance, for a Site process rendering a preset tree (CONTENT.md). A
 * Page or Area with a Site override answers its content with its tree; a preset tree never reaches
 * phi-server, so its Widgets' content is asked for here.
 */
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
  const rawLocale = url.searchParams.get("locale") ?? request.headers.get("x-locale");
  return handleSiteWidgetContentRead(request, site, rawLocale?.trim() ? normalizeLocale(rawLocale) : null);
}
