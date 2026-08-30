import { NextRequest, NextResponse } from "next/server";

import { searchSiteGroupMemberCandidates } from "@/db/user-admin";
import { requireSiteGroupManagerAnywhereApiContext } from "@/lib/guards/site-group-api";

export const dynamic = "force-dynamic";

/*
 * People a Manager may name as a member of their group.
 *
 * The Site's user list is Developer-only, and rightly so -- but a Manager who cannot find a colleague
 * cannot run their group, and the level would be half a level. This is the narrow middle: open to
 * anyone who manages some group, matched on name or address, capped, and answering with the name and
 * company rather than the address that may have been searched by.
 *
 * `groupId` is optional and names the group the answer is about: each row then says whether that person
 * is already in it, which is what decides whether naming them adds a member or changes a level. It is
 * not an authority parameter -- what a Manager may see of the Site's people does not change with it.
 */
export async function GET(request: NextRequest) {
  const guarded = await requireSiteGroupManagerAnywhereApiContext(request);
  if (guarded.error) return guarded.error;

  const query = (request.nextUrl.searchParams.get("q") ?? "").trim();
  const limit = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "", 10);
  const groupId = Number.parseInt(request.nextUrl.searchParams.get("groupId") ?? "", 10);
  return NextResponse.json({
    rows: await searchSiteGroupMemberCandidates({
      siteId: guarded.context!.site!.id,
      query,
      limit: Number.isSafeInteger(limit) ? limit : undefined,
      groupId: Number.isSafeInteger(groupId) && groupId > 0 ? groupId : null,
    }),
  });
}
