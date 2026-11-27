import { NextRequest, NextResponse } from "next/server";

import { listPhisBillingIssuers } from "@/lib/billing/capability";
import { editPhisBillingSeries } from "@/lib/billing/documents";
import { phisBillingErrorResponse } from "@/lib/billing/routes";
import { requireSiteBillingApiContext } from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * Changes a series' `label`, `kinds` and `sources` (Admin and Accountant). Once it has numbered a document
 * (`Used`) its kinds only grow; key, template and reset never change here. Answers `{ series }`.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteBillingApiContext(request);
  if (error) return error;
  const body = await readRequestBody(request);
  try {
    const series = await editPhisBillingSeries(context.site.id, (await params).id, { label: body.label, kinds: body.kinds, sources: body.sources }, listPhisBillingIssuers());
    return series ? NextResponse.json({ series }) : NextResponse.json({ error: "Series not found." }, { status: 404 });
  } catch (failure) {
    return phisBillingErrorResponse(failure);
  }
}
