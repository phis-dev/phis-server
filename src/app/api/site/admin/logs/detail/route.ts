import { NextRequest, NextResponse } from "next/server";

import { readPhiSiteAdminLog } from "@/lib/admin-logs";
import { requireSiteDeveloperApiContext } from "@/lib/guards/site-admin-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteDeveloperApiContext(request);
  if (error) {
    return error;
  }
  const site = context.site;
  const recordId = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!recordId) {
    return NextResponse.json({ error: "Log identity is required." }, { status: 400 });
  }

  try {
    const record = await readPhiSiteAdminLog(site.key, recordId);
    return record
      ? NextResponse.json({ record })
      : NextResponse.json({ error: "Log entry not found." }, { status: 404 });
  } catch (caughtError) {
    return NextResponse.json(
      {
        error: caughtError instanceof Error ? caughtError.message : "Failed to read log detail.",
      },
      { status: 500 },
    );
  }
}
