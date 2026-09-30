import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  readEffectiveGroupMembershipFlags,
  removeLocalSiteGroupMembership,
  setLocalSiteGroupMembership,
} from "@/db/site-groups";
import { readPhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import {
  canWriteSiteGroupMembership,
  requireSiteGroupManagerApiContext,
} from "@/lib/guards/site-group-api";

function parseId(value: string) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const FORBIDDEN_MANAGER_WRITE = {
  error: "manager_level_forbidden",
  message: "Only a developer or admin may grant or revoke the Manager level.",
} as const;

/*
 * Two authorities share these routes. Developer and Admin administer any group at any level; a group's
 * own Manager administers Author, Editor and Member in that group only. The group id is parsed before the
 * guard runs because the guard's decision depends on it.
 */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ groupId: string; userId: string }> },
) {
  const params = await context.params;
  const groupId = parseId(params.groupId);
  const userId = parseId(params.userId);
  const body = await request.json().catch(() => null) as { membershipFlags?: unknown } | null;
  const next = readPhiGroupMembershipFlags(body?.membershipFlags);
  if (!groupId || !userId || next === null) {
    return NextResponse.json({ error: "invalid_membership" }, { status: 400 });
  }
  const guarded = await requireSiteGroupManagerApiContext(request, groupId);
  if (guarded.error) return guarded.error;
  const siteId = guarded.context!.site!.id;
  const current = await readEffectiveGroupMembershipFlags(siteId, groupId, userId);
  if (!canWriteSiteGroupMembership(guarded.context!.authority, { next, current })) {
    return NextResponse.json(FORBIDDEN_MANAGER_WRITE, { status: 403 });
  }
  try {
    const membership = await setLocalSiteGroupMembership({
      siteId,
      groupId,
      userId,
      membershipFlags: next,
    });
    return NextResponse.json({ membership });
  } catch (error) {
    return NextResponse.json({
      error: "membership_update_failed",
      message: error instanceof Error ? error.message : "Membership update failed.",
    }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ groupId: string; userId: string }> },
) {
  const params = await context.params;
  const groupId = parseId(params.groupId);
  const userId = parseId(params.userId);
  if (!groupId || !userId) {
    return NextResponse.json({ error: "invalid_membership" }, { status: 400 });
  }
  const guarded = await requireSiteGroupManagerApiContext(request, groupId);
  if (guarded.error) return guarded.error;
  const siteId = guarded.context!.site!.id;
  // Removing a Manager is a demotion, so it is closed to a Manager for the same reason granting is.
  const current = await readEffectiveGroupMembershipFlags(siteId, groupId, userId);
  if (!canWriteSiteGroupMembership(guarded.context!.authority, { current })) {
    return NextResponse.json(FORBIDDEN_MANAGER_WRITE, { status: 403 });
  }
  const membership = await removeLocalSiteGroupMembership({ siteId, groupId, userId });
  return NextResponse.json({ membership });
}
