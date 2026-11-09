import { NextRequest, NextResponse } from "next/server";

import { parsePhiAdminLogQuery, readPhiSiteAdminLogs } from "@/lib/admin-logs";
import { requireSiteDeveloperApiContext } from "@/lib/guards/site-admin-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteDeveloperApiContext(request);
  if (error) {
    return error;
  }
  const site = context.site;

  const query = parsePhiAdminLogQuery(new URL(request.url).searchParams);

  try {
    return NextResponse.json(await readPhiSiteAdminLogs(site.key, query));
  } catch (caughtError) {
    return NextResponse.json(
      {
        error: caughtError instanceof Error ? caughtError.message : "Failed to read logs.",
      },
      { status: 500 },
    );
  }
}
