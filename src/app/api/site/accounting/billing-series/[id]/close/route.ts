import { NextRequest, NextResponse } from "next/server";

import { closePhisBillingSeriesById } from "@/lib/billing/documents";
import { phisBillingErrorResponse } from "@/lib/billing/routes";
import { requireSiteBillingApiContext } from "@/lib/guards/site-admin-api";

export const dynamic = "force-dynamic";

/** Closes a series (Admin and Accountant): it numbers nothing more, its documents stay. Answers `{ series }`. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteBillingApiContext(request);
  if (error) return error;
  try {
    const series = await closePhisBillingSeriesById(context.site.id, (await params).id);
    return series ? NextResponse.json({ series }) : NextResponse.json({ error: "Series not found." }, { status: 404 });
  } catch (failure) {
    return phisBillingErrorResponse(failure);
  }
}
