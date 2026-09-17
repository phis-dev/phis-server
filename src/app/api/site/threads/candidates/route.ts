import { NextRequest, NextResponse } from "next/server";

import { listThreadCandidates, readSiteThreadKinds } from "@/db/threads";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";

export const dynamic = "force-dynamic";

/**
 * Who this person may address, and which kinds of thread this Site offers.
 *
 * It is deliberately not the Site's user list, which stays Developer-only: the people here are the ones
 * the actor already shares a group with, and what crosses is a display name and, where the group
 * discloses it, a company. The kinds ride along because a composer has to know whether to offer a group
 * thread at all, and asking twice for one form would be two round trips for one question.
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

  const [candidates, config] = await Promise.all([
    listThreadCandidates(site.id, userId),
    readSiteThreadKinds(site.id),
  ]);

  return NextResponse.json({
    users: candidates.users,
    groups: candidates.groups,
    kindFlags: config.flags,
  });
}
