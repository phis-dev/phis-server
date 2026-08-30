import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { readEffectiveGroupMembershipFlags } from "@/db/site-groups";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import { canPhiViewerAccess, PHI_ACCESS_DEVELOPER_TOOLS } from "@/lib/authorization";
import { requireSiteAuthenticatedApiContext, type SiteAdminApiContext } from "@/lib/guards/site-admin-api";

export type SiteGroupApiAuthority = {
  /** Developer or Admin: authority over every group, including the Manager level itself. */
  siteWide: boolean;
  /** The actor's own effective level in this group. */
  membershipFlags: number;
};

export type SiteGroupApiContext = SiteAdminApiContext & { authority: SiteGroupApiAuthority };

/**
 * Authorizes finding people to put in a group.
 *
 * Not tied to one group, because the candidates never were: they are the Site's members either way, and
 * a `groupId` would only have dressed an unchanged list as a per-group one. What it does require is
 * that the actor manages some group at all -- someone with no group to run has no one to look for.
 */
export async function requireSiteGroupManagerAnywhereApiContext(
  request: NextRequest,
): Promise<{ context: SiteGroupApiContext | null; error: NextResponse | null }> {
  const guarded = await requireSiteAuthenticatedApiContext(request);
  if (guarded.error || !guarded.context) return { context: null, error: guarded.error };

  const context = guarded.context;
  const groupClaims = context.siteRole?.groupClaims ?? [];
  const siteWide = canPhiViewerAccess({
    authenticated: true,
    roleClaims: context.siteRole?.roleClaims ?? [],
    groupClaims,
  }, PHI_ACCESS_DEVELOPER_TOOLS);
  const managesSomething = siteWide || groupClaims.some((claim) =>
    (claim.flags & PhiGroupMembershipFlags.Manager) === PhiGroupMembershipFlags.Manager);

  if (!managesSomething) {
    return {
      context: null,
      error: NextResponse.json(
        { error: "Group manager, developer, or admin authority required." },
        { status: 403 },
      ),
    };
  }

  return {
    context: { ...context, authority: { siteWide, membershipFlags: PhiGroupMembershipFlags.Manager } },
    error: null,
  };
}

/**
 * Authorizes reading one group.
 *
 * Membership is what grants it: someone in a group sees who else is in it. Work is assigned to a
 * person as readily as to a team, and a list only Managers could read would put that behind an
 * authority nobody needs for it. What a member sees of the others is narrower than what
 * administration sees -- that is a projection question, settled where the rows are built.
 */
export async function requireSiteGroupMemberApiContext(
  request: NextRequest,
  groupId: number,
): Promise<{ context: SiteGroupApiContext | null; error: NextResponse | null }> {
  return authorizeSiteGroupRequest(request, groupId, PhiGroupMembershipFlags.Member);
}

/**
 * Authorizes a group administration request.
 *
 * Two authorities reach the same routes and they are not the same authority. Developer and Admin
 * administer any group, including who is a Manager. A group's own Manager administers that group and
 * nothing above their own level -- what they may write is decided per operation by the caller, because
 * only the caller knows which level a request is trying to set.
 */
export async function requireSiteGroupManagerApiContext(
  request: NextRequest,
  groupId: number,
): Promise<{ context: SiteGroupApiContext | null; error: NextResponse | null }> {
  return authorizeSiteGroupRequest(request, groupId, PhiGroupMembershipFlags.Manager);
}

async function authorizeSiteGroupRequest(
  request: NextRequest,
  groupId: number,
  requiredLevel: number,
): Promise<{ context: SiteGroupApiContext | null; error: NextResponse | null }> {
  const guarded = await requireSiteAuthenticatedApiContext(request);
  if (guarded.error || !guarded.context) return { context: null, error: guarded.error };

  const context = guarded.context;
  const siteWide = canPhiViewerAccess({
    authenticated: true,
    roleClaims: context.siteRole?.roleClaims ?? [],
    groupClaims: context.siteRole?.groupClaims ?? [],
  }, PHI_ACCESS_DEVELOPER_TOOLS);

  const membershipFlags = siteWide
    ? PhiGroupMembershipFlags.Manager
    : await readEffectiveGroupMembershipFlags(context.site!.id, groupId, context.session!.userId);

  if (!siteWide && (membershipFlags & requiredLevel) !== requiredLevel) {
    return {
      context: null,
      error: NextResponse.json(
        {
          error: requiredLevel === PhiGroupMembershipFlags.Member
            ? "Group membership, developer, or admin authority required."
            : "Group manager, developer, or admin authority required.",
        },
        { status: 403 },
      ),
    };
  }

  return { context: { ...context, authority: { siteWide, membershipFlags } }, error: null };
}

/**
 * Whether this actor may write this membership level.
 *
 * The levels are cumulative, so a Manager who could set or clear the Manager bit would be granting or
 * revoking their own authority. Both the level being written and the level already on the row are
 * checked: demoting or removing a Manager is a demotion just as much as never appointing one.
 */
export function canWriteSiteGroupMembership(
  authority: SiteGroupApiAuthority,
  levels: { next?: number; current: number },
) {
  if (authority.siteWide) return true;
  const touchesManager = (levels.current & PhiGroupMembershipFlags.Manager) === PhiGroupMembershipFlags.Manager ||
    ((levels.next ?? 0) & PhiGroupMembershipFlags.Manager) === PhiGroupMembershipFlags.Manager;
  return !touchesManager;
}
