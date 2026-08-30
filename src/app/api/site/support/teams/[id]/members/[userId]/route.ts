import { NextRequest, NextResponse } from "next/server";

import { deleteSupportTeamMember } from "@/db/support";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

function parsePositiveId(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const resolved = await params;
  const teamId = parsePositiveId(resolved.id);
  const userId = parsePositiveId(resolved.userId);
  if (!teamId || !userId) {
    return NextResponse.json({ error: "Invalid team or user id." }, { status: 400 });
  }

  const deleted = await deleteSupportTeamMember(site.id, teamId, userId);
  if (!deleted) {
    return NextResponse.json({ error: "Team member not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.team.member.deleted", {
    area: "support",
    message: "Support team member deleted.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { teamId, memberUserId: userId },
  });

  return NextResponse.json({});
}
