import { NextRequest, NextResponse } from "next/server";

import {
  SupportAdministrationError,
  createSupportTicketType,
  listSupportTicketTypes,
  setSupportRequesterWindowDays,
} from "@/db/support";
import { readSiteThreadKinds } from "@/db/threads";
import {
  requireSiteDeveloperApiContext,
  requireSiteSupportApiContext,
} from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";
import {
  readSupportAdministrationKey,
  readSupportAdministrationName,
  readSupportAllowanceInput,
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
 * question, answered by `PhisSupportTicketTypeFlag.Requestable` and `GET /api/site/support/request/types`
 * ([design/SUPPORT.md](../../../../../design/SUPPORT.md) section 2).
 *
 * Beside the rows stands `requesterWindowDays`, the Site's window: what every type without one of its
 * own falls back to, which makes it the catalogue's default rather than a setting of its own.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }
  const site = context.site;
  const [rows, config] = await Promise.all([listSupportTicketTypes(site.id), readSiteThreadKinds(site.id)]);
  return NextResponse.json({ rows, requesterWindowDays: config.requesterWindowDays });
}

/**
 * Sets what the catalogue as a whole says: `requesterWindowDays`, the window every type without its own
 * falls back to. `0` switches automatic closing off for every type at once.
 *
 * Behind `Developer | Admin`, as adding a type is.
 */
export async function PATCH(request: NextRequest) {
  const { context, error } = await requireSiteDeveloperApiContext(request);
  if (error) {
    return error;
  }
  const site = context.site;

  const body = await readRequestBody(request);
  const requesterWindowDays = readSupportInteger(body.requesterWindowDays);
  if (requesterWindowDays == null) {
    return NextResponse.json({ error: "requesterWindowDays is required." }, { status: 400 });
  }
  try {
    await setSupportRequesterWindowDays(site.id, requesterWindowDays);
  } catch (cause) {
    return refuseSupportAdministration(cause, SupportAdministrationError);
  }
  const config = await readSiteThreadKinds(site.id);
  return NextResponse.json({ requesterWindowDays: config.requesterWindowDays });
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
  const site = context.site;

  const body = await readRequestBody(request);
  const key = readSupportAdministrationKey(body.key);
  const name = readSupportAdministrationName(body.name);
  if (!key || !name) {
    return NextResponse.json({ error: "A ticket type needs a key and a name." }, { status: 400 });
  }
  const requesterAllowance = readSupportAllowanceInput(body.requesterAllowance);
  if (requesterAllowance === false) {
    return NextResponse.json(
      { error: "An allowance is a count and a period (1 = month, 2 = year), or null for none." },
      { status: 400 },
    );
  }

  try {
    const id = await createSupportTicketType({
      siteId: site.id,
      key,
      name,
      flags: readSupportInteger(body.flags) ?? 0,
      closePolicy: readSupportInteger(body.closePolicy) ?? 0,
      requesterWindowDays: readSupportInteger(body.requesterWindowDays),
      requesterAllowance,
      sortOrder: readSupportInteger(body.sortOrder) ?? 0,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (cause) {
    return refuseSupportAdministration(cause, SupportAdministrationError);
  }
}
