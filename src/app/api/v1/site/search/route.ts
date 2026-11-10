import { NextRequest, NextResponse } from "next/server";
import {
  PHI_SEARCH_DEFAULT_LIMIT,
  PHI_SEARCH_INDEXED_AREA_MASK,
  PHI_SEARCH_MAX_LIMIT,
  PHI_SEARCH_QUERY_PARAM,
  readPhiSearchQuery,
  type PhiSearchResponse,
} from "@phis/contracts/search";

import { searchSiteDocuments } from "@/db/site-search";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { isPhisCmsAreaKey, resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import { resolveRequestLocale } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";

/**
 * `GET /api/v1/site/search?q=&areas=public,app&limit=` -- the Site's Pages matching a visitor's query
 * (SEARCH.md), in the language of the request.
 *
 * Asked by the Site while it draws its results Page, with the internal token: the Site has already
 * decided which Areas this visitor may search -- a Public Page searches Public, an App Page searches App
 * and Public, and nobody reaches an App Page without signing in -- and names them in `areas`. An Area
 * outside the indexed two is a mistake in the request, not a thing to search less of.
 *
 * A query too short to be one answers an empty result rather than a refusal: the Widget already said
 * so to the visitor, and the one request that still arrives is a link somebody typed.
 */
export async function GET(request: NextRequest) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;

  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const rawAreas = (searchParams.get("areas") ?? "public").split(",").map((entry) => entry.trim().toLowerCase());
  if (rawAreas.some((entry) => !isPhisCmsAreaKey(entry))) {
    return NextResponse.json({ error: "Invalid search areas." }, { status: 400 });
  }
  const areaMask = rawAreas.reduce((mask, entry) => mask | resolvePhisCmsAreaMask(entry), 0);
  if ((areaMask & PHI_SEARCH_INDEXED_AREA_MASK) !== areaMask) {
    return NextResponse.json({ error: "Only the Public and App Areas are searched." }, { status: 400 });
  }
  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? PHI_SEARCH_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PHI_SEARCH_MAX_LIMIT) {
    return NextResponse.json({ error: "Invalid search limit." }, { status: 400 });
  }

  const locale = resolveRequestLocale(request.headers);
  const query = readPhiSearchQuery(searchParams.get(PHI_SEARCH_QUERY_PARAM));
  const result = query
    ? await searchSiteDocuments({ siteId: site.id, areaMask, locale, query, limit })
    : { hits: [], total: 0 };

  const body: PhiSearchResponse = {
    query: query ?? "",
    locale,
    areaMask,
    hits: result.hits,
    total: result.total,
  };
  return createJsonResponse(request, body, { cacheControl: "no-store" });
}
