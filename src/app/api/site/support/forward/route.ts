import { NextRequest, NextResponse } from "next/server";

import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { normalizeString, readRequestBody } from "@/lib/helpers/request";
import {
  forwardSupportTicket,
  listSupportForwardTargets,
  SupportForwardError,
} from "@/lib/support-forwarding";
import { readSupportTicketReach, supportTicketWithinReach } from "@/lib/support-reach";

export const dynamic = "force-dynamic";

/**
 * Where this Site's tickets may be forwarded right now.
 *
 * Every target of every installed `support-forwarding` implementation that resolves for the Site and
 * answers its probe as usable: `{ target: "<providerKey>#<key>", label }`. Behind `Developer | Supporter`,
 * who forward.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }
  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  return NextResponse.json({ rows: await listSupportForwardTargets({ id: site.id, key: site.key }) });
}

/**
 * Hands one ticket's work to one target: `{ ticketId, target, title? }`.
 *
 * The ticket travels in the body rather than in the path so a declared Form can relay here; a relay
 * handler names one static upstream path. The answer is the ticket as it now stands -- an engineering task
 * linked to the external record, and the ticket waiting on it.
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
  // A number from a REST caller, a string from a Form's hidden field: the same ticket either way.
  const ticketId = typeof body.ticketId === "number" ? body.ticketId : Number.parseInt(normalizeString(body.ticketId), 10);
  const target = normalizeString(body.target);
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0 || !target) {
    return NextResponse.json({ error: "A forward needs a ticket and a target." }, { status: 400 });
  }
  // A ticket outside the reader's queues answers as one that is not there (`lib/support-reach.ts`).
  if (!(await supportTicketWithinReach(site.id, ticketId, readSupportTicketReach(context)))) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }
  const title = normalizeString(body.title);
  if (title.length > 200) {
    return NextResponse.json({ error: "That title is too long." }, { status: 400 });
  }

  try {
    const detail = await forwardSupportTicket({
      site: { id: site.id, key: site.key },
      ticketId,
      target,
      title: title || null,
      actorUserId: userId,
    });
    return NextResponse.json(detail);
  } catch (cause) {
    if (cause instanceof SupportForwardError) {
      const status = cause.code === "not-found" ? 404 : cause.code === "failed" ? 502 : 409;
      return NextResponse.json({ error: cause.message, code: cause.code }, { status });
    }
    throw cause;
  }
}
