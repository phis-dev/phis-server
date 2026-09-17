import { NextRequest, NextResponse } from "next/server";

import { listSupportQueues } from "@/db/support";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";

export const dynamic = "force-dynamic";

/**
 * The Site's Support queues.
 *
 * Where work is routed, and the group each one routes to. Who is in that group is a group question and
 * is answered by the group surfaces -- a queue owns routing, never membership.
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

  return NextResponse.json({ rows: await listSupportQueues(site.id) });
}
