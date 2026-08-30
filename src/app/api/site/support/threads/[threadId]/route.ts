import { NextRequest, NextResponse } from "next/server";

import { getSupportThreadDetail } from "@/db/support";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";

export const dynamic = "force-dynamic";

function parsePositiveId(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const threadId = parsePositiveId((await params).threadId);
  if (!threadId) {
    return NextResponse.json({ error: "Invalid thread id." }, { status: 400 });
  }

  const thread = await getSupportThreadDetail(site.id, userId, threadId);
  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  return NextResponse.json({ thread });
}
