import { NextRequest, NextResponse } from "next/server";

import { createSupportTeam, listSupportTeams } from "@/db/support";
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

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const rows = await listSupportTeams(site.id);
  return NextResponse.json({ rows });
}

export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const key = normalizeTeamKey(body.key);
  const name = normalizeString(body.name);
  if (!key || !name) {
    return NextResponse.json({ error: "key and name are required." }, { status: 400 });
  }

  const team = await createSupportTeam({
    siteId: site.id,
    key,
    name,
    flags: normalizeInteger(body.flags) ?? 0,
    sortOrder: normalizeInteger(body.sortOrder) ?? 0,
  });

  logRuntimeEvent("info", "site.support.team.created", {
    area: "support",
    message: "Support team created.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { teamId: team?.id ?? null, key },
  });

  return NextResponse.json({ team }, { status: 201 });
}
