import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  ensureGroupMediaSpace,
  ensureSiteMediaConfig,
  ensureUserMediaSpace,
  getMediaSpaceById,
  isPhiMediaSpaceKindEnabled,
  PhisMediaSpaceKind,
  resolveMediaQuotaCeilingBytes,
  setMediaSpaceQuotaBytes,
  type MediaSpaceRecord,
  type SiteMediaConfigRecord,
} from "@/db/media-spaces";
import { readEffectiveGroupMembershipFlags } from "@/db/site-groups";
import { canPhiViewerAccess, PHI_ACCESS_DEVELOPER_TOOLS } from "@/lib/authorization";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { parseRequestedMediaSpace } from "@/lib/guards/site-media-api";
import { logRuntimeEvent } from "@/lib/log";
import { serializeMediaSpace } from "@/lib/media-response";

/**
 * The capacity override of one Media Space.
 *
 * Two authorities reach this route. Developer and Admin set any Space's override and own the ceiling
 * it is measured against; a group's Manager sets their own group's, up to that ceiling. Delegated
 * capacity without a ceiling would not be delegated capacity at all -- an actor who can raise their own
 * allowance has none -- so the ceiling is checked here, on the server, and never in an interface.
 *
 * A Space that has no row yet can still be given an override: assigning capacity is a decision made
 * ahead of use, and a revocation that had to wait for the first upload would always arrive too late.
 * Materializing for that reason is an administrative act, not the Author write that ordinarily
 * brings a Group Space into existence.
 */
function readQuotaBytes(value: unknown, issues: string[]) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    issues.push("quotaBytes must be null or a non-negative integer.");
    return undefined;
  }
  return value;
}

function exceedsCeiling(
  space: Pick<MediaSpaceRecord, "kind">,
  config: SiteMediaConfigRecord,
  quotaBytes: number | null,
) {
  const ceiling = resolveMediaQuotaCeilingBytes(space.kind, config);
  return ceiling != null && (quotaBytes == null || quotaBytes > ceiling);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ address: string }> },
) {
  const { address } = await context.params;
  const requested = parseRequestedMediaSpace(address);
  if (requested == null || requested === "user") {
    return NextResponse.json({ error: "invalid_space_address" }, { status: 400 });
  }

  const body = await request.json().catch(() => null) as { quotaBytes?: unknown } | null;
  const issues: string[] = [];
  const quotaBytes = readQuotaBytes(body?.quotaBytes, issues);
  if (quotaBytes === undefined || issues.length > 0) {
    return NextResponse.json({ error: "invalid_quota", details: issues }, { status: 400 });
  }

  const guarded = await requireSiteAuthenticatedApiContext(request);
  if (guarded.error) return guarded.error;
  const siteId = guarded.context!.site!.id;
  const userId = guarded.context!.session!.userId;
  const siteWide = canPhiViewerAccess({
    authenticated: true,
    roleClaims: guarded.context!.siteRole?.roleClaims ?? [],
    groupClaims: guarded.context!.siteRole?.groupClaims ?? [],
  }, PHI_ACCESS_DEVELOPER_TOOLS);

  const config = await ensureSiteMediaConfig(siteId);
  let space: MediaSpaceRecord | null = null;

  if (typeof requested === "number") {
    space = await getMediaSpaceById(siteId, requested);
    if (!space) return NextResponse.json({ error: "space_not_found" }, { status: 404 });
    if (!siteWide) {
      // A Manager reaches their own group's Space by any address; nothing else is theirs to size.
      const flags = space.kind === PhisMediaSpaceKind.Group && space.groupId != null
        ? await readEffectiveGroupMembershipFlags(siteId, space.groupId, userId, guarded.context!.siteRole?.groupClaims)
        : 0;
      if ((flags & PhiGroupMembershipFlags.Manager) !== PhiGroupMembershipFlags.Manager) {
        return NextResponse.json({ error: "space_forbidden" }, { status: 403 });
      }
    }
  } else if (requested.kind === "group") {
    if (!isPhiMediaSpaceKindEnabled(config, PhisMediaSpaceKind.Group)) {
      return NextResponse.json({ error: "space_kind_unavailable" }, { status: 409 });
    }
    if (!siteWide) {
      const flags = await readEffectiveGroupMembershipFlags(
        siteId,
        requested.groupId,
        userId,
        guarded.context!.siteRole?.groupClaims,
      );
      if ((flags & PhiGroupMembershipFlags.Manager) !== PhiGroupMembershipFlags.Manager) {
        return NextResponse.json({ error: "space_forbidden" }, { status: 403 });
      }
    }
    space = await ensureGroupMediaSpace(siteId, requested.groupId);
    if (!space) return NextResponse.json({ error: "space_not_found" }, { status: 404 });
  } else {
    // Naming another user's Space is administration and has no group Manager equivalent.
    if (!siteWide) return NextResponse.json({ error: "space_forbidden" }, { status: 403 });
    if (!isPhiMediaSpaceKindEnabled(config, PhisMediaSpaceKind.User)) {
      return NextResponse.json({ error: "space_kind_unavailable" }, { status: 409 });
    }
    space = await ensureUserMediaSpace(siteId, requested.userId);
  }

  if (!siteWide && exceedsCeiling(space, config, quotaBytes)) {
    return NextResponse.json({
      error: "quota_ceiling_exceeded",
      message: "The requested quota exceeds the Site ceiling for this Space kind.",
      ceilingBytes: resolveMediaQuotaCeilingBytes(space.kind, config),
    }, { status: 403 });
  }

  const updated = await setMediaSpaceQuotaBytes(siteId, space.id, quotaBytes);
  if (!updated) return NextResponse.json({ error: "space_not_found" }, { status: 404 });
  logRuntimeEvent("info", "site.media.space.quota.updated", {
    siteKey: guarded.context!.site!.key,
    userId,
    method: request.method,
    path: request.nextUrl.pathname,
    meta: { spaceId: updated.id, kind: updated.kind, quotaBytes, siteWide },
  });
  return NextResponse.json({ space: serializeMediaSpace(updated, config) });
}
