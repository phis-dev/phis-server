import { NextRequest, NextResponse } from "next/server";

import { listPhisBillingListeners } from "@/lib/billing/capability";
import { openPhisBillingDocument } from "@/lib/billing/documents";
import { phisBillingErrorResponse } from "@/lib/billing/routes";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * Opens one of the signed-in person's own documents: `{ disposition: "inline" | "attachment",
 * ttlSeconds? }` answers `{ url, expiresAt }`, a signed address valid for that one document (300 seconds
 * by default, at most 900). `404` for a document that is not theirs, `409` for one not available.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) return error;
  const body = await readRequestBody(request);
  try {
    return NextResponse.json(await openPhisBillingDocument({
      siteId: context.site.id, addonId: null, actorUserId: context.session.userId,
      // The person's own only: Admin and Accountant open through the Accounting route.
      billingStaff: async () => false, listeners: listPhisBillingListeners,
    }, { documentId: (await params).id, disposition: body.disposition, ttlSeconds: body.ttlSeconds }));
  } catch (failure) {
    return phisBillingErrorResponse(failure);
  }
}
