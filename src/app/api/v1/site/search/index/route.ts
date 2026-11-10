import { NextRequest, NextResponse } from "next/server";
import {
  PHI_SEARCH_INDEXED_AREA_MASK,
  PHI_SEARCH_MAX_DOCUMENTS,
  type PhiSearchIndexWriteResult,
} from "@phis/contracts/search";

import {
  listSiteSearchIndexStates,
  readSiteSearchDocument,
  replaceSiteSearchDocuments,
} from "@/db/site-search";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { isPhisCmsAreaKey, resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import { requireSiteFromRequest } from "@/lib/site-context";

/**
 * `GET /api/v1/site/search/index` -- the sets phis holds of this Site, with the fingerprint each was
 * built from (SEARCH.md). A Site process compares them with what it would build now and writes only the
 * sets that differ.
 */
export async function GET(request: NextRequest) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;

  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });

  return createJsonResponse(request, { sets: await listSiteSearchIndexStates(site.id) }, { cacheControl: "no-store" });
}

/**
 * `PUT /api/v1/site/search/index` -- one set of documents, replacing what phis held of that Area and
 * language (SEARCH.md).
 *
 * The body is `PhiSearchIndexSet` with the Area named by its key (`area: "public"`). A set whose
 * fingerprint phis already holds is answered `accepted: false` and leaves everything as it was; that is
 * the normal answer when several Site processes notice one publish. A document without a path, or
 * with a path that is not an address, is dropped and the rest written: one broken Page is not a reason
 * to leave the whole Site unsearchable, and the Site's log says which one.
 */
export async function PUT(request: NextRequest) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;

  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    area?: unknown;
    locale?: unknown;
    fingerprint?: unknown;
    documents?: unknown;
  } | null;
  const area = typeof body?.area === "string" ? body.area.trim().toLowerCase() : "";
  const locale = typeof body?.locale === "string" ? body.locale.trim() : "";
  const fingerprint = typeof body?.fingerprint === "string" ? body.fingerprint.trim() : "";
  if (!isPhisCmsAreaKey(area) || !locale || locale.length > 8 || !fingerprint || !Array.isArray(body?.documents)) {
    return NextResponse.json({ error: "Invalid search index set." }, { status: 400 });
  }
  const areaMask = resolvePhisCmsAreaMask(area);
  if ((areaMask & PHI_SEARCH_INDEXED_AREA_MASK) !== areaMask) {
    return NextResponse.json({ error: "Only the Public and App Areas are indexed." }, { status: 400 });
  }
  if (body.documents.length > PHI_SEARCH_MAX_DOCUMENTS) {
    return NextResponse.json({ error: `A set carries at most ${PHI_SEARCH_MAX_DOCUMENTS} documents.` }, { status: 400 });
  }

  const documents = body.documents.map(readSiteSearchDocument);
  const dropped = documents.filter((document) => document === null).length;
  const result = await replaceSiteSearchDocuments(
    { siteId: site.id, areaMask, locale },
    fingerprint,
    documents.filter((document) => document !== null),
  );
  if (result.status === "invalid") {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }

  const answer: PhiSearchIndexWriteResult & { dropped: number } = {
    accepted: result.status === "written",
    state: result.state,
    dropped,
  };
  return createJsonResponse(request, answer, { cacheControl: "no-store" });
}
