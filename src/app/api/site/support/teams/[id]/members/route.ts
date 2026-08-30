import { NextRequest, NextResponse } from "next/server";

import {
  getSupportTeamBySiteAndId,
  listSupportTeamMembers,
  upsertSupportTeamMember,
} from "@/db/support";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { normalizeString, readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function normalizeInteger(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  const parsed = Number.parseInt(normalizeString(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parsePositiveId(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const teamId = parsePositiveId((await params).id);
  if (!teamId) {
    return NextResponse.json({ error: "Invalid team id." }, { status: 400 });
  }

  const team = await getSupportTeamBySiteAndId(site.id, teamId);
  if (!team) {
    return NextResponse.json({ error: "Team not found." }, { status: 404 });
  }

  const rows = await listSupportTeamMembers(site.id, teamId);
  return NextResponse.json({ team, rows });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const teamId = parsePositiveId((await params).id);
  if (!teamId) {
    return NextResponse.json({ error: "Invalid team id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
  const userId = normalizeInteger(body.userId);
  if (!userId || userId <= 0) {
    return NextResponse.json({ error: "userId is required." }, { status: 400 });
  }

  const member = await upsertSupportTeamMember({
    siteId: site.id,
    teamId,
    userId,
    flags: normalizeInteger(body.flags) ?? 0,
  });

  if (!member) {
    return NextResponse.json({ error: "Team or user not found for this site." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.team.member.upserted", {
    area: "support",
    message: "Support team member upserted.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { teamId, memberUserId: userId },
  });

  return NextResponse.json({ member }, { status: 201 });
}
