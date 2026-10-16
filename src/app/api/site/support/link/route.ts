import { NextRequest, NextResponse } from "next/server";

import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { normalizeString, readRequestBody } from "@/lib/helpers/request";
import { linkSupportTicket, SupportForwardError } from "@/lib/support-forwarding";

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
  const ticketId = typeof body.ticketId === "number" ? body.ticketId : Number.parseInt(normalizeString(body.ticketId), 10);
  const reference = normalizeString(body.reference);
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0 || !reference) {
    return NextResponse.json({ error: "A link needs a ticket and a reference." }, { status: 400 });
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
