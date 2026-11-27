import { NextRequest, NextResponse } from "next/server";

import { listPhisBillingIssuers } from "@/lib/billing/capability";
import { createPhisBillingSeries, listPhisBillingSeriesRecords } from "@/lib/billing/documents";
import { phisBillingErrorResponse } from "@/lib/billing/routes";
import { requireSiteBillingApiContext } from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * "Number series" in Accounting, Admin and Accountant only: `{ series }`, every series of the Site newest
 * first, each with the number the next issue would get now (`next`) and `issuers`, the installed Add-ons a
 * series may name (their manifest declares `billing.issues`).
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteBillingApiContext(request);
  if (error) return error;
  return NextResponse.json({ series: await listPhisBillingSeriesRecords(context.site.id), issuers: listPhisBillingIssuers() });
}

/**
 * Adds a series: `{ key, label, template, reset, kinds, sources?, replaces? }`. With `replaces` (the id of
 * the key's open series) that one is closed in the same step -- how a used template changes. Answers `201`
 * with `{ series }`; `400` with the rule a field breaks, `409` where the key already has an open series.
 */
export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteBillingApiContext(request);
  if (error) return error;
  const body = await readRequestBody(request);
  try {
    const series = await createPhisBillingSeries(context.site.id, {
      key: body.key, label: body.label, template: body.template, reset: body.reset, kinds: body.kinds, sources: body.sources, replaces: body.replaces,
    }, listPhisBillingIssuers());
    return NextResponse.json({ series }, { status: 201 });
  } catch (failure) {
    return phisBillingErrorResponse(failure);
  }
}
