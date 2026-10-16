import { NextRequest, NextResponse } from "next/server";

import { listSupportTicketEvents } from "@/db/support-ticket-events";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { parseStrictPositiveInt } from "@/lib/helpers/request";
import { readSupportTicketReach, supportTicketWithinReach } from "@/lib/support-reach";

export const dynamic = "force-dynamic";

/**
 * What happened to a ticket, oldest first: opened, moved on the ladder, taken, moved between queues,
 * forwarded, closed. For Supporters only -- the history names queues, owners and where work was
 * forwarded, which a requester is not told.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const ticketId = parseStrictPositiveInt((await params).ticketId);
  if (!ticketId) {
    return NextResponse.json({ error: "Invalid ticket id." }, { status: 400 });
  }
  // A ticket outside the reader's queues answers as one that is not there (`lib/support-reach.ts`).
  if (!(await supportTicketWithinReach(site.id, ticketId, readSupportTicketReach(context)))) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }

  const events = await listSupportTicketEvents(site.id, ticketId);
  if (!events) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }

  return NextResponse.json({ events });
}
