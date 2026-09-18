import { NextRequest, NextResponse } from "next/server";

import { listRequestableSupportTicketTypes } from "@/db/support";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";

export const dynamic = "force-dynamic";

/**
 * What a person who is not Staff may ask for.
 *
 * Not the Staff catalogue with a filter over it. A requester is told the key, the name, and whether the
 * conversation leaves the Site; what ends the ticket, how long the requester window is and what order
 * Staff keeps the catalogue in are answers about how the work will be run, and a person choosing what
 * to ask for has no use for them.
 *
 * `external` is the reason this route exists separately at all. A type whose conversation is mirrored
 * into a repository has to be declared as such **before** the person writes rather than after, and a
 * listing that did not carry it would have them choose one without knowing
 * ([design/SUPPORT.md](../../../../../../design/SUPPORT.md) section 2).
 *
 * The guard is the Site's ordinary session. Holding a Support role is what lets somebody answer a
 * ticket, and requiring it here would mean only Staff could ask for help.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) {
    return error;
  }
  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  /*
   * The listing is this person's, which is why it takes their id.
   *
   * What they may still ask for is part of what a type is to them, and it belongs here rather than in
   * the refusal: being turned away after writing the request is being turned away at the worst possible
   * moment. See [design/SUPPORT.md](../../../../../../design/SUPPORT.md) section 5.
   */
  return NextResponse.json({ rows: await listRequestableSupportTicketTypes(site.id, userId) });
}
