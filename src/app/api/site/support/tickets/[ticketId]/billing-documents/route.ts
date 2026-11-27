import { NextRequest, NextResponse } from "next/server";

import { findPhisBillingSubjectOfUser, listPhisBillingDocuments, readPhisBillingTicketRequester } from "@/db/billing.mts";
import { supportTicketWithinReach } from "@/db/support";
import { PHI_CORE_ROLE_PROVIDER_ID, PhiBaseRole } from "@/lib/authorization";
import { getPool } from "@/lib/db";
import { resolveSiteRoleApiContext } from "@/lib/guards/site-admin-api";
import { decodePhisBillingCursor, encodePhisBillingCursor, phisBillingErrorResponse, phisBillingListFields, readPhisBillingLimitParam } from "@/lib/billing/routes";
import { parseStrictPositiveInt } from "@/lib/helpers/request";
import { readSupportTicketReach } from "@/lib/support-reach";

export const dynamic = "force-dynamic";

/**
 * The billing documents of a support ticket's requester, for a Supporter (and the Admin) who may work on
 * the ticket, while it is open (before Resolved): `{ documents, cursor }`, list fields only -- no content and
 * no file to open (owner, 2026-11-27). A Maintainer is refused: the Site access `support` admits one, the
 * documents do not.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
  const { context, error } = await resolveSiteRoleApiContext(request, {
    policy: { access: "roles", providerId: PHI_CORE_ROLE_PROVIDER_ID, allowedRoleFlags: PhiBaseRole.Supporter },
    missingRoleMessage: "Site supporter or admin role required.",
  });
  if (error || !context?.site || !context.session) return error!;
  const ticketId = parseStrictPositiveInt((await params).ticketId);
  if (!ticketId) return NextResponse.json({ error: "Invalid ticket id." }, { status: 400 });
  // A ticket outside the reader's queues answers as one that is not there, as the ticket itself does.
  if (!(await supportTicketWithinReach(context.site.id, ticketId, readSupportTicketReach(context as Parameters<typeof readSupportTicketReach>[0])))) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }
  const ticket = await readPhisBillingTicketRequester(getPool(), context.site.id, ticketId);
  if (!ticket) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  if (!ticket.open) return NextResponse.json({ error: "The ticket is not open." }, { status: 409 });
  try {
    const subjectId = ticket.requesterUserId === null ? null : await findPhisBillingSubjectOfUser(getPool(), context.site.id, ticket.requesterUserId);
    if (subjectId === null) return NextResponse.json({ documents: [], cursor: null });
    const query = request.nextUrl.searchParams;
    const page = await listPhisBillingDocuments(getPool(), { siteId: context.site.id, subjectId },
      { cursor: decodePhisBillingCursor(query.get("cursor")), limit: readPhisBillingLimitParam(query.get("limit")) });
    return NextResponse.json({ documents: page.documents.map(document => phisBillingListFields(document.record)), cursor: encodePhisBillingCursor(page.next) });
  } catch (failure) {
    return phisBillingErrorResponse(failure);
  }
}
