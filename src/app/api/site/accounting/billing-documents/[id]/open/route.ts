import { NextRequest, NextResponse } from "next/server";

import { listPhisBillingListeners } from "@/lib/billing/capability";
import { openPhisBillingDocument } from "@/lib/billing/documents";
import { phisBillingErrorResponse } from "@/lib/billing/routes";
import { requireSiteBillingApiContext } from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/** Opens any document of the Site for Admin and Accountant: `{ disposition, ttlSeconds? }` answers `{ url, expiresAt }`. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteBillingApiContext(request);
  if (error) return error;
  const body = await readRequestBody(request);
  try {
    return NextResponse.json(await openPhisBillingDocument({
      siteId: context.site.id, addonId: null, actorUserId: context.session.userId, billingStaff: async () => true, listeners: listPhisBillingListeners,
    }, { documentId: (await params).id, disposition: body.disposition, ttlSeconds: body.ttlSeconds }));
  } catch (failure) {
    return phisBillingErrorResponse(failure);
  }
}
