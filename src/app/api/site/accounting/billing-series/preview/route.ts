import { NextRequest, NextResponse } from "next/server";

import { previewPhisBillingSeries } from "@/lib/billing/documents";
import { phisBillingErrorResponse } from "@/lib/billing/routes";
import { requireSiteBillingApiContext } from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * What a template would number first, now, in the Site's time zone: `{ template, reset }` answers
 * `{ next }`, or `400` with the rule it breaks -- the Form's preview, answered by Core and never computed in
 * the browser.
 */
export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteBillingApiContext(request);
  if (error) return error;
  const body = await readRequestBody(request);
  try {
    return NextResponse.json(await previewPhisBillingSeries(context.site.id, { template: body.template, reset: body.reset }));
  } catch (failure) {
    return phisBillingErrorResponse(failure);
  }
}
