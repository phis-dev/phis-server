import { NextRequest, NextResponse } from "next/server";

import {
  SUPPORT_TICKET_CHANNEL_PORTAL,
  createSupportTicket,
  getRequestableSupportTicketType,
  hasSupportEntryQueue,
} from "@/db/support";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { normalizeString, readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * The way in for the person asking.
 *
 * Not `POST /api/site/support/tickets` with a softer guard. That route is a Supporter opening a ticket
 * on somebody's behalf and takes the queue, the priority, the assignee and the severity -- answers about
 * how the work will be run. Letting the person asking write them would let them jump their own ticket,
 * so this route takes a subject, a first message, a type, and nothing else.
 *
 * It names no queue either. `PhisSupportQueueFlag.Entry` has already decided that, and a Site that has
 * not marked one refuses the ticket rather than dropping it wherever the first row happens to be -- the
 * one failure this route can have for a reason that is not the requester's.
 *
 * See [design/SUPPORT.md](../../../../../design/SUPPORT.md) section 2.
 */
export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) {
    return error;
  }
  const site = context?.site;
  const requesterUserId = context?.session?.userId ?? null;
  if (!site || !requesterUserId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const typeKey = normalizeString(body.typeKey).toLowerCase();
  const subject = normalizeString(body.subject);
  const message = normalizeString(body.message);
  if (!typeKey || !subject || !message) {
    return NextResponse.json(
      { error: "A request needs a type, a subject and a first message." },
      { status: 400 },
    );
  }
  if (subject.length > 200) {
    return NextResponse.json({ error: "That subject is too long." }, { status: 400 });
  }

  /*
   * A type the Site does not offer to requesters is absent rather than forbidden.
   *
   * Answering "you may not ask for this one" tells whoever asked that a Staff-only type exists and what
   * it is called. What a requester may choose is the listing beside this route, and anything else is
   * simply not a type as far as this route is concerned.
   */
  const type = await getRequestableSupportTicketType(site.id, typeKey);
  if (!type) {
    return NextResponse.json({ error: "That is not a type you can ask for." }, { status: 400 });
  }

  /*
   * Consent belongs to the moment they write.
   *
   * A ticket of an `External` type has its conversation mirrored outside, and a customer's words are
   * their own. Recording the acknowledgement when the ticket opens is what keeps the integration from
   * having to chase somebody later for consent they were never asked for -- so an `External` type
   * without it is refused here rather than exported and regretted.
   */
  if (type.external && body.acknowledgedExternal !== true) {
    return NextResponse.json(
      {
        error: "This kind of request is mirrored outside the Site, and needs your acknowledgement.",
        external: true,
      },
      { status: 409 },
    );
  }

  if (!await hasSupportEntryQueue(site.id)) {
    // The Site has not finished setting itself up. Said plainly, because the requester can do nothing
    // about it and the alternative is a ticket nobody is looking at.
    logRuntimeEvent("warn", "site.support.request.no_entry_queue", {
      siteKey: site.key,
      meta: { siteId: site.id },
    });
    return NextResponse.json(
      { error: "This Site is not accepting requests yet." },
      { status: 503 },
    );
  }

  const created = await createSupportTicket({
    siteId: site.id,
    typeId: type.id,
    subject,
    message,
    channel: SUPPORT_TICKET_CHANNEL_PORTAL,
    requesterUserId,
    createdByUserId: requesterUserId,
    requesterExternalConsent: type.external,
  });
  if (!created) {
    return NextResponse.json({ error: "The request could not be opened." }, { status: 500 });
  }

  // The thread is what they read and write from here on; the ticket id is the Site's own handle on it.
  return NextResponse.json(
    { id: created.ticket.id, threadId: created.ticket.threadId },
    { status: 201 },
  );
}
