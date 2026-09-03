import { NextResponse } from "next/server";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { listPublishedNews } from "@/db/site-content";
import { resolveRequestLocale } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";
import { PHIS_SITE_KEY_HEADER, PHIS_TOKEN_HEADER } from "@/lib/constants/http-headers";

const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": `${PHIS_TOKEN_HEADER}, ${PHIS_SITE_KEY_HEADER}, content-type`,
};

export async function GET(request: Request) {
  const guardError = guardApiV1(request);
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json(
      { error: "Missing site context." },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const locale = resolveRequestLocale(request.headers);
  const items = await listPublishedNews(site.id, locale);
  const version = items[0]?.created?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);

  return createJsonResponse(
    request,
    { version, site: site.key, locale, news: items },
    { cacheControl: CACHE_CONTROL, headers: CORS_HEADERS },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
