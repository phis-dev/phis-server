import { NextRequest, NextResponse } from "next/server";

import { markSupportThreadRead } from "@/db/support";
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

export async function POST(request: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
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

  const body = await readRequestBody(request);
  const thread = await markSupportThreadRead(site.id, userId, threadId, normalizeInteger(body.messageId));
  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.thread.read", {
    area: "support",
    message: "Support thread marked as read.",
    siteKey: site.key,
    userId,
    meta: { threadId },
  });

  return NextResponse.json({ thread });
}
