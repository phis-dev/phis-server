import { NextRequest, NextResponse } from "next/server";

import { findPhisBillingSubjectOfUser, listPhisBillingDocuments } from "@/db/billing.mts";
import { getPool } from "@/lib/db";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import {
  decodePhisBillingCursor, encodePhisBillingCursor, phisBillingErrorResponse, phisBillingListRows, readPhisBillingKindsParam,
  readPhisBillingLimitParam, readPhisBillingYearParam,
} from "@/lib/billing/routes";

export const dynamic = "force-dynamic";

/**
 * "Invoices and receipts": the signed-in person's own billing documents on this Site, every issuer and
 * source, newest first, never a detached one (`billing:v1`). Query: `kinds` (comma-separated), `year`,
 * `cursor`, `limit` (1 to 100, default 50). Answers `{ documents, cursor }`, each a list row: the document
 * without its structured content, with `dueAt` (a merchant's invoice's or reminder's due date, else null)
 * and `correctsNumber` (the number of the invoice a credit note or reminder refers to, else null).
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) return error;
  try {
    const query = request.nextUrl.searchParams;
    const year = readPhisBillingYearParam(query.get("year"));
    const subjectId = await findPhisBillingSubjectOfUser(getPool(), context.site.id, context.session.userId);
    if (subjectId === null) return NextResponse.json({ documents: [], cursor: null });
    const page = await listPhisBillingDocuments(getPool(), {
      siteId: context.site.id, subjectId, kinds: readPhisBillingKindsParam(query.get("kinds")),
      issuedFrom: year?.from ?? null, issuedTo: year?.to ?? null,
    }, { cursor: decodePhisBillingCursor(query.get("cursor")), limit: readPhisBillingLimitParam(query.get("limit")) });
    return NextResponse.json({ documents: await phisBillingListRows(context.site.id, page.documents.map(document => document.record)), cursor: encodePhisBillingCursor(page.next) });
  } catch (failure) {
    return phisBillingErrorResponse(failure);
  }
}
