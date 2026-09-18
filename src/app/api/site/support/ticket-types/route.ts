import { NextRequest, NextResponse } from "next/server";

import {
  SupportAdministrationError,
  createSupportTicketType,
  listSupportTicketTypes,
} from "@/db/support";
import {
  requireSiteDeveloperApiContext,
  requireSiteSupportApiContext,
} from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";
import {
  readSupportAdministrationKey,
  readSupportAdministrationName,
  readSupportInteger,
  refuseSupportAdministration,
} from "@/lib/guards/site-support-administration";

export const dynamic = "force-dynamic";

/**
 * The Site's ticket types.
 *
 * What kinds of Support work this Site handles, which is the Site's own catalogue and not a vocabulary
 * compiled into the server. Retired types are listed too, with `retiredAt` set: whoever administers the
 * catalogue has to see what the tickets already opened are still naming.
 *
 * This is the Staff listing, behind the Supporter role. What a requester may choose is a different
 * question, answered by `PhisSupportTicketTypeFlag.Requestable`, and by a route that does not exist yet
 * ([design/SUPPORT.md](../../../../../design/SUPPORT.md) section 2).
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
  return NextResponse.json({ rows: await listSupportTicketTypes(site.id) });
}

/**
 * Adds a ticket type.
 *
 * Behind `Developer | Admin`, as the queues are: a type decides what may leave the Site and what ends a
 * ticket, which is not a decision that belongs to everyone who answers one.
 */
export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteDeveloperApiContext(request);
  if (error) {
    return error;
  }
  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const key = readSupportAdministrationKey(body.key);
  const name = readSupportAdministrationName(body.name);
  if (!key || !name) {
    return NextResponse.json({ error: "A ticket type needs a key and a name." }, { status: 400 });
  }

  try {
    const id = await createSupportTicketType({
      siteId: site.id,
      key,
      name,
      flags: readSupportInteger(body.flags) ?? 0,
      closePolicy: readSupportInteger(body.closePolicy) ?? 0,
      requesterWindowDays: readSupportInteger(body.requesterWindowDays),
      sortOrder: readSupportInteger(body.sortOrder) ?? 0,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (cause) {
    return refuseSupportAdministration(cause, SupportAdministrationError);
  }
}
