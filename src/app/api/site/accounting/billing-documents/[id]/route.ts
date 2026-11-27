import { NextRequest, NextResponse } from "next/server";

import { listPhisBillingCorrections, readPhisBillingDocument, readPhisBillingSeries } from "@/db/billing.mts";
import { getPool } from "@/lib/db";
import { requireSiteBillingApiContext } from "@/lib/guards/site-admin-api";
import { phisBillingListFields } from "@/lib/billing/routes";

export const dynamic = "force-dynamic";

/**
 * One document for the read-only detail dialog, Admin and Accountant only: `{ document, corrections,
 * corrected, series, voidReason }` -- the document with its structured content, the credit notes and
 * reminders that refer to it, the invoice it refers to, the series it was numbered from, and why it was
 * voided. `404` for none.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteBillingApiContext(request);
  if (error) return error;
  const document = await readPhisBillingDocument(getPool(), context.site.id, (await params).id);
  if (!document) return NextResponse.json({ error: "Document not found." }, { status: 404 });
  const corrections = await listPhisBillingCorrections(getPool(), context.site.id, document.record.id);
  const corrected = document.record.correctsId ? await readPhisBillingDocument(getPool(), context.site.id, document.record.correctsId) : null;
  const series = document.seriesId ? await readPhisBillingSeries(getPool(), context.site.id, document.seriesId) : null;
  return NextResponse.json({
    document: document.record,
    corrections: corrections.map(entry => phisBillingListFields(entry.record)),
    corrected: corrected ? phisBillingListFields(corrected.record) : null,
    series: series ? { id: series.id, key: series.key, label: series.label, template: series.template } : null,
    voidReason: document.voidReason,
  });
}
