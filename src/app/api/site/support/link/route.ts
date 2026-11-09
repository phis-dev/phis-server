import { NextRequest, NextResponse } from "next/server";

import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { normalizeString, parseStrictPositiveInt, readRequestBody } from "@/lib/helpers/request";
import { linkSupportTicket, SupportForwardError } from "@/lib/support-forwarding";
import { readSupportTicketReach } from "@/lib/support-reach";
import { supportTicketWithinReach } from "@/db/support";

export const dynamic = "force-dynamic";

/**
 * Links a record that already exists elsewhere to one ticket: `{ ticketId, reference }`.
 *
 * `reference` is what the Supporter pasted -- an issue's URL, `owner/name#12` -- and whichever installed
 * `support-forwarding` implementation knows it answers. The ticket travels in the body so a declared Form
 * can relay here, as it does for a forward; the answer is the ticket as it now stands, waiting on the work.
 * Behind `Developer | Supporter`, who forward.
 */
export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }
  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const ticketId = parseStrictPositiveInt(body.ticketId);
  const reference = normalizeString(body.reference);
  if (ticketId == null || !reference) {
    return NextResponse.json({ error: "A link needs a ticket and a reference." }, { status: 400 });
  }
  // A ticket outside the reader's queues answers as one that is not there (`lib/support-reach.ts`).
  if (!(await supportTicketWithinReach(site.id, ticketId, readSupportTicketReach(context)))) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }
  if (reference.length > 500) {
    return NextResponse.json({ error: "That reference is too long." }, { status: 400 });
  }

  try {
    return NextResponse.json(await linkSupportTicket({
      site: { id: site.id, key: site.key },
      ticketId,
      reference,
      actorUserId: userId,
    }));
  } catch (cause) {
    if (cause instanceof SupportForwardError) {
      const status = cause.code === "not-found" ? 404 : cause.code === "failed" ? 502 : cause.code === "unknown-reference" ? 422 : 409;
      return NextResponse.json({ error: cause.message, code: cause.code }, { status });
    }
    throw cause;
  }
}
