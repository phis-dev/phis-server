import { NextRequest, NextResponse } from "next/server";

import { listSupportRecipientUsers, listSupportTeams } from "@/db/support";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const [users, teams] = await Promise.all([
    listSupportRecipientUsers(site.id),
    listSupportTeams(site.id),
  ]);

  return NextResponse.json({
    users: users.filter((entry) => entry.id !== userId),
    teams,
  });
}
