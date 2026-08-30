import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  getSiteGroupById,
  listSiteGroupMembers,
  projectSiteGroupMemberForMember,
} from "@/db/site-groups";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import { requireSiteGroupMemberApiContext } from "@/lib/guards/site-group-api";

/*
 * Reading one group's members.
 *
 * Membership is what grants it: someone in a group sees who else is in it, because work is assigned to
 * a person as readily as to a team. What a plain member sees of the others is narrower than what
 * administration sees -- no address, and the company only when the group says so.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ groupId: string }> },
) {
  const { groupId: rawGroupId } = await context.params;
  const groupId = Number.parseInt(rawGroupId, 10);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    return NextResponse.json({ error: "invalid_group" }, { status: 400 });
  }

  const guarded = await requireSiteGroupMemberApiContext(request, groupId);
  if (guarded.error) return guarded.error;
  const siteId = guarded.context!.site!.id;
  const group = await getSiteGroupById(siteId, groupId);
  if (!group) return NextResponse.json({ error: "group_not_found" }, { status: 404 });

  const administers = guarded.context!.authority.siteWide ||
    (guarded.context!.authority.membershipFlags & PhiGroupMembershipFlags.Manager)
      === PhiGroupMembershipFlags.Manager;
  const members = await listSiteGroupMembers(siteId, groupId);
  return NextResponse.json({
    group: { id: group.id, key: group.key, name: group.name, providerId: group.providerId, flags: group.flags },
    members: administers
      ? members
      : members.map((member) => projectSiteGroupMemberForMember(member, group.flags)),
  });
}
