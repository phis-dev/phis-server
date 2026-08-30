import { NextRequest, NextResponse } from "next/server";

import {
  createLocalSiteGroup,
  getSiteGroupById,
  listSiteGroupMembers,
  listSiteGroups,
  listSiteGroupsForUser,
  projectSiteGroupMemberForMember,
  readEffectiveGroupMembershipFlags,
  removeLocalSiteGroupMembership,
  setLocalSiteGroupMembership,
  setSiteGroupFlags,
  setSiteGroupRetirement,
} from "@/db/site-groups";
import { getGroupMediaSpace } from "@/db/media-spaces";
import {
  PhiGroupMembershipFlags,
  PhiSiteGroupFlags,
  normalizePhiGroupMembershipFlags,
} from "@/lib/constants/site-groups";
import {
  canWriteSiteGroupMembership,
  requireSiteGroupManagerApiContext,
  requireSiteGroupMemberApiContext,
} from "@/lib/guards/site-group-api";
import {
  requireSiteAuthenticatedApiContext,
  requireSiteDeveloperApiContext,
} from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { canPhiViewerAccess, PHI_ACCESS_DEVELOPER_TOOLS } from "@/lib/authorization";

export const dynamic = "force-dynamic";

/*
 * Site groups, as a browser session reaches them.
 *
 * One resource, one address: "the groups I am in" and "all of them" are the same question asked with
 * a different scope, not two things -- and splitting them once meant the same membership write lived
 * in two files. What each actor may see and do is settled here, per request, which is where it was
 * always settled anyway. `groups:v1` under /api/v1 stays separate: that is the provider-neutral
 * capability a Module speaks to, not a session surface.
 */
function parseId(value: string | null) {
  if (!value) return null;
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** A Form control hands back a string even for a numeric choice. */
function readValue(value: unknown) {
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : null;
}

function administers(authority: { siteWide: boolean; membershipFlags: number }) {
  return authority.siteWide ||
    (authority.membershipFlags & PhiGroupMembershipFlags.Manager) === PhiGroupMembershipFlags.Manager;
}

export async function GET(request: NextRequest) {
  const groupId = parseId(request.nextUrl.searchParams.get("groupId"));
  if (groupId != null) {
    const guarded = await requireSiteGroupMemberApiContext(request, groupId);
    if (guarded.error) return guarded.error;
    const siteId = guarded.context!.site!.id;
    const group = await getSiteGroupById(siteId, groupId);
    if (!group) return NextResponse.json({ error: "group_not_found" }, { status: 404 });
    const members = await listSiteGroupMembers(siteId, groupId);
    const manages = administers(guarded.context!.authority);
    return NextResponse.json({
      /*
       * `manages` says what this actor may do here, so the interface does not have to work it out from
       * a level it would have to fetch separately -- and cannot get it wrong in the direction of
       * offering a control the route would then refuse.
       */
      group: {
        id: group.id, key: group.key, name: group.name, flags: group.flags, manages,
        retired: group.retiredAt != null,
      },
      // A Manager administers their group here, so they see the row as administration does.
      members: manages
        ? members
        : members.map((member) => projectSiteGroupMemberForMember(member, group.flags)),
    });
  }

  const guarded = await requireSiteAuthenticatedApiContext(request);
  if (guarded.error) return guarded.error;
  const siteId = guarded.context!.site!.id;
  const userId = guarded.context!.session!.userId;
  /*
   * Developer and Admin administer every group, so the rows say so too -- otherwise a page would offer
   * them nothing while the routes accept everything, and the two would disagree about the same actor.
   */
  const siteWide = canPhiViewerAccess({
    authenticated: true,
    roleClaims: guarded.context!.siteRole?.roleClaims ?? [],
    groupClaims: guarded.context!.siteRole?.groupClaims ?? [],
  }, PHI_ACCESS_DEVELOPER_TOOLS);

  /*
   * Which groups, not whose authority: "the ones I am in" and "all of them" are different questions
   * about the same resource, so they are one route with a scope rather than two paths. The Site-wide
   * scope is what needs Developer or Admin; asking for one's own needs nothing but being signed in.
   */
  const scope = request.nextUrl.searchParams.get("scope") === "site" ? "site" : "mine";
  if (scope === "site" && !siteWide) {
    return NextResponse.json({ error: "site_scope_forbidden" }, { status: 403 });
  }

  const memberships = new Map(
    (await listSiteGroupsForUser(siteId, userId)).map((group) => [group.id, group.membershipFlags]),
  );
  /*
   * Retired groups are asked for, never included by default. Every caller that offers a group to choose
   * from reads this route, and a retired group must disappear from selection -- so the default answer
   * is the groups in service, and administration says when it wants the others. The member scope cannot
   * contain one either way, because a retired group grants no membership.
   */
  const includeRetired = scope === "site" && request.nextUrl.searchParams.get("includeRetired") === "1";
  const source = scope === "site"
    ? await listSiteGroups(siteId, { includeRetired })
    : await listSiteGroupsForUser(siteId, userId);

  /*
   * The Space is reported alongside each group because that is what the level means in practice: a
   * Contributor may write into it, a Member sees it. A group whose Space nothing has written to yet has
   * none -- reading must not be what creates it.
   */
  const rows = await Promise.all(source.map(async (group) => {
    const space = await getGroupMediaSpace(siteId, group.id);
    const membershipFlags = memberships.get(group.id) ?? 0;
    return {
      id: group.id,
      key: group.key,
      name: group.name,
      providerId: group.providerId,
      local: group.capabilities.includes("update"),
      // Null rather than zero where the actor is not in the group at all: "no level" and "the lowest
      // level" are different answers, and a Site-wide listing is full of the first.
      membershipFlags: membershipFlags === 0 ? null : membershipFlags,
      canContribute:
        (membershipFlags & PhiGroupMembershipFlags.Contributor) === PhiGroupMembershipFlags.Contributor,
      manages: siteWide ||
        (membershipFlags & PhiGroupMembershipFlags.Manager) === PhiGroupMembershipFlags.Manager,
      memberCount: "memberCount" in group ? group.memberCount : null,
      showMemberCompany: (group.flags & PhiSiteGroupFlags.ShowMemberCompany) !== 0,
      retired: group.retiredAt != null,
      retiredAt: group.retiredAt,
      spaceId: space?.id ?? null,
      spaceUsedBytes: space?.usedBytes ?? null,
      spaceQuotaBytes: space?.quotaBytes ?? null,
    };
  }));
  return NextResponse.json({ rows, total: rows.length });
}

/**
 * Creating a group is Site administration: a group is an authorization unit Pages, Navigation, and
 * Assets refer to, so group membership must never confer the authority to create more of them.
 */
export async function POST(request: NextRequest) {
  const guarded = await requireSiteDeveloperApiContext(request);
  if (guarded.error) return guarded.error;
  const body = await request.json().catch(() => null) as { key?: unknown; name?: unknown } | null;
  if (typeof body?.key !== "string" || typeof body?.name !== "string") {
    return NextResponse.json({ error: "invalid_group" }, { status: 400 });
  }
  try {
    const group = await createLocalSiteGroup({
      siteId: guarded.context!.site!.id,
      key: body.key,
      name: body.name,
    });
    logRuntimeEvent("info", "site.groups.created", {
      siteKey: guarded.context!.site!.key,
      userId: guarded.context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: { groupId: group.id, key: group.key },
    });
    return NextResponse.json({ group }, { status: 201 });
  } catch (error) {
    return NextResponse.json({
      error: "group_create_failed",
      message: error instanceof Error ? error.message : "Group creation failed.",
    }, { status: 400 });
  }
}

/**
 * Writes one property of a group: how it displays its members, or whether it is still in service.
 *
 * Retiring is a Manager operation, because a Manager runs the team and may end it. Putting one back is
 * not: a retired group grants nothing, so the Manager level in it is gone the moment it is retired and
 * cannot be the authority that returns it. Requiring Developer or Admin there keeps the way back open
 * instead of making it depend on a right the operation itself removed.
 */
export async function PATCH(request: NextRequest) {
  const groupId = parseId(request.nextUrl.searchParams.get("groupId"));
  const body = await request.json().catch(() => null) as {
    showMemberCompany?: unknown; retired?: unknown;
  } | null;
  const setsCompany = typeof body?.showMemberCompany === "boolean";
  const setsRetired = typeof body?.retired === "boolean";
  if (!groupId || setsCompany === setsRetired) {
    return NextResponse.json({ error: "invalid_group_patch" }, { status: 400 });
  }
  const guarded = await requireSiteGroupManagerApiContext(request, groupId);
  if (guarded.error) return guarded.error;
  const siteId = guarded.context!.site!.id;
  const group = await getSiteGroupById(siteId, groupId);
  if (!group) return NextResponse.json({ error: "group_not_found" }, { status: 404 });

  if (setsRetired) {
    const retired = body!.retired as boolean;
    if (!retired && !guarded.context!.authority.siteWide) {
      return NextResponse.json({
        error: "reactivate_forbidden",
        message: "Only a developer or admin may put a retired group back in service.",
      }, { status: 403 });
    }
    const updated = await setSiteGroupRetirement({ siteId, groupId, retired });
    if (!updated) {
      // Either the state already matched, or the group belongs to a provider and has no state to write.
      return NextResponse.json({
        error: "group_retirement_unchanged",
        message: "The group is already in that state, or it is owned by a directory provider.",
      }, { status: 409 });
    }
    logRuntimeEvent("info", retired ? "site.groups.retired" : "site.groups.reactivated", {
      siteKey: guarded.context!.site!.key,
      userId: guarded.context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: { groupId: updated.id, key: updated.key },
    });
    return NextResponse.json({ group: updated });
  }

  return NextResponse.json({
    group: await setSiteGroupFlags(siteId, groupId, body!.showMemberCompany
      ? group.flags | PhiSiteGroupFlags.ShowMemberCompany
      : group.flags & ~PhiSiteGroupFlags.ShowMemberCompany),
  });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => null) as {
    groupId?: unknown; userId?: unknown; membershipFlags?: unknown;
  } | null;
  // Named in the query by a Table editing one cell, in the body by a Form relaying to a fixed path.
  const groupId = parseId(request.nextUrl.searchParams.get("groupId")) ?? parseId(readValue(body?.groupId));
  const userId = parseId(request.nextUrl.searchParams.get("userId")) ?? parseId(readValue(body?.userId));
  const membershipFlags = Number(readValue(body?.membershipFlags));
  if (!groupId || !userId || !Number.isInteger(membershipFlags)) {
    return NextResponse.json({ error: "invalid_membership" }, { status: 400 });
  }
  const guarded = await requireSiteGroupManagerApiContext(request, groupId);
  if (guarded.error) return guarded.error;
  const siteId = guarded.context!.site!.id;
  // A retired group takes nobody new. Refused here rather than left to the write to fail, so the answer
  // says what happened instead of reporting a broken request.
  const group = await getSiteGroupById(siteId, groupId);
  if (group?.retiredAt != null) {
    return NextResponse.json({
      error: "group_retired",
      message: "This group has been retired. Put it back in service before changing its members.",
    }, { status: 409 });
  }
  const current = await readEffectiveGroupMembershipFlags(siteId, groupId, userId);
  const next = normalizePhiGroupMembershipFlags(membershipFlags);
  if (!canWriteSiteGroupMembership(guarded.context!.authority, { next, current })) {
    return NextResponse.json({
      error: "manager_level_forbidden",
      message: "Only a developer or admin may grant or revoke the Manager level.",
    }, { status: 403 });
  }
  return NextResponse.json({
    groupClaims: await setLocalSiteGroupMembership({ siteId, groupId, userId, membershipFlags: next }),
  });
}

export async function DELETE(request: NextRequest) {
  const groupId = parseId(request.nextUrl.searchParams.get("groupId"));
  const userId = parseId(request.nextUrl.searchParams.get("userId"));
  if (!groupId || !userId) {
    return NextResponse.json({ error: "invalid_membership" }, { status: 400 });
  }
  const guarded = await requireSiteGroupManagerApiContext(request, groupId);
  if (guarded.error) return guarded.error;
  const siteId = guarded.context!.site!.id;
  const current = await readEffectiveGroupMembershipFlags(siteId, groupId, userId);
  if (!canWriteSiteGroupMembership(guarded.context!.authority, { current })) {
    return NextResponse.json({
      error: "manager_level_forbidden",
      message: "Only a developer or admin may grant or revoke the Manager level.",
    }, { status: 403 });
  }
  return NextResponse.json({
    groupClaims: await removeLocalSiteGroupMembership({ siteId, groupId, userId }),
  });
}
