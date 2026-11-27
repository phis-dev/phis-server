import { NextRequest, NextResponse } from "next/server";

import { listPhisBillingListeners } from "@/lib/billing/capability";
import { retryPhisProviderDocument } from "@/lib/billing/documents";
import { phisBillingErrorResponse } from "@/lib/billing/routes";
import { requireSiteBillingApiContext } from "@/lib/guards/site-admin-api";

export const dynamic = "force-dynamic";

/**
 * Starts the fetching of a Provider's document that was given up again (Admin and Accountant): it is
 * `pending` and its collection task runs from its first retry. Answers `{ document }`; `409` for a document
 * that is not a failed Provider's.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteBillingApiContext(request);
  if (error) return error;
  try {
    const document = await retryPhisProviderDocument(context.site.id, (await params).id, listPhisBillingListeners);
    return document ? NextResponse.json({ document }) : NextResponse.json({ error: "Document not found." }, { status: 404 });
  } catch (failure) {
    return phisBillingErrorResponse(failure);
  }
}
