import { NextRequest, NextResponse } from "next/server";

import {
  deleteSupportTeamBySite,
  getSupportTeamBySiteAndId,
  updateSupportTeam,
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

function normalizeTeamKey(value: unknown) {
  return normalizeString(value).toLowerCase();
}

function parseTeamId(value: string) {
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

  const teamId = parseTeamId((await params).id);
  if (!teamId) {
    return NextResponse.json({ error: "Invalid team id." }, { status: 400 });
  }

  const team = await getSupportTeamBySiteAndId(site.id, teamId);
  if (!team) {
    return NextResponse.json({ error: "Team not found." }, { status: 404 });
  }

  return NextResponse.json({ team });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const teamId = parseTeamId((await params).id);
  if (!teamId) {
    return NextResponse.json({ error: "Invalid team id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
  if (Object.hasOwn(body, "key") && !normalizeTeamKey(body.key)) {
    return NextResponse.json({ error: "key cannot be empty." }, { status: 400 });
  }
  if (Object.hasOwn(body, "name") && !normalizeString(body.name)) {
    return NextResponse.json({ error: "name cannot be empty." }, { status: 400 });
  }

  const team = await updateSupportTeam({
    siteId: site.id,
    teamId,
    key: Object.hasOwn(body, "key") ? normalizeTeamKey(body.key) : undefined,
    name: Object.hasOwn(body, "name") ? normalizeString(body.name) : undefined,
    flags: Object.hasOwn(body, "flags") ? (normalizeInteger(body.flags) ?? undefined) : undefined,
    sortOrder: Object.hasOwn(body, "sortOrder") ? (normalizeInteger(body.sortOrder) ?? undefined) : undefined,
  });

  if (!team) {
    return NextResponse.json({ error: "Team not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.team.updated", {
    area: "support",
    message: "Support team updated.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { teamId },
  });

  return NextResponse.json({ team });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const teamId = parseTeamId((await params).id);
  if (!teamId) {
    return NextResponse.json({ error: "Invalid team id." }, { status: 400 });
  }

  const deleted = await deleteSupportTeamBySite(site.id, teamId);
  if (!deleted) {
    return NextResponse.json({ error: "Team not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.team.deleted", {
    area: "support",
    message: "Support team deleted.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { teamId },
  });

  return NextResponse.json({});
}
